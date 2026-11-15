import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudMonitor } from '../src/cloudflare-monitor.mjs';

const daytime = Date.parse('2026-11-14T15:00:00Z');
const env = () => ({ MONITOR_MODE: 'live', INITIAL_TELEGRAM_CURSOR: '100', INITIAL_WHATSAPP_CURSOR: '100',
  TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', TELEGRAM_CHAT_ID: '123456789',
  WHATSAPP_PHONE: '+5511999999999', CALLMEBOT_API_KEY: 'test-key-123' });
function storage() {
  const data = new Map();
  return { data, get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)); } };
}
function feed(id = 101, price = '4.500,00') {
  return `<div data-post="TJGOFERTASs/100"><div class="tgme_widget_message_text">Outra publicação</div><time datetime="2026-11-14T14:58:00Z"></time></div><div data-post="TJGOFERTASs/${id}"><div class="tgme_widget_message_text">RTX 5070 12GB<br>R$ ${price}</div><time datetime="2026-11-14T14:59:00Z"></time></div>`;
}
function transport() {
  const sent = [], reads = [];
  let failWhatsApp = false;
  return { sent, reads, set failWhatsApp(value) { failWhatsApp = value; }, fetcher: async (url, init) => {
    if (String(url).startsWith('https://t.me/s/')) { reads.push(url); return new Response(feed()); }
    if (String(url).startsWith('https://api.telegram.org/')) {
      const message = JSON.parse(init.body); sent.push({ channel: 'telegram', message });
      return Response.json({ ok: true, result: { chat: { id: 123456789, type: 'private' } } });
    }
    if (String(url).startsWith('https://api.callmebot.com/')) {
      if (failWhatsApp) throw new Error(`Simulated failure ${url}`);
      sent.push({ channel: 'whatsapp', message: new URL(url).searchParams.get('text') });
      return new Response('Message queued');
    }
    throw new Error('Unexpected outbound destination');
  }};
}
function setup(settings = env(), now = () => daytime, store = storage()) {
  const net = transport(), reports = [];
  const monitor = new CloudMonitor(store, settings, { fetcher: net.fetcher, now, report: value => reports.push(value) });
  return { monitor, net, store, reports, settings };
}

test('explicit one-shot cloud diagnostics read the feed outside hours without moving live cursors', async () => {
  const s = setup({ ...env(), MONITOR_MODE: 'test', TEST_RUN_ID: 'feed-probe', TEST_READ_FEED: 'true' },
    () => Date.parse('2026-11-15T02:10:00Z'));
  const result = await s.monitor.tick();
  assert.equal(result.feed.postsChecked, 2);
  assert.equal(result.feed.latest, 101);
  assert.equal(s.net.reads.length, 1);
  assert.equal(s.net.sent.length, 2);
  assert.equal(s.store.data.has('channel:telegram'), false);
  assert.equal(s.store.data.has('channel:whatsapp'), false);
  await s.monitor.tick();
  assert.equal(s.net.reads.length, 1);
  assert.equal(s.net.sent.length, 2);
});

test('imports prior cursors and does not resend the same GPU after a restart', async () => {
  const s = setup();
  assert.equal((await s.monitor.tick()).status, 'ok');
  assert.equal(s.net.sent.length, 2);
  assert.equal(s.net.sent[0].message.chat_id, '123456789');
  assert.match(s.net.sent[0].message.text, /RTX 5070 por R\$\s*4\.500,00/);
  assert.match(s.net.sent[1].message, /https:\/\/t.me\/TJGOFERTASs\/101/);
  assert.equal(s.store.data.get('channel:telegram').cursor, 101);
  const restarted = new CloudMonitor(s.store, s.settings, { fetcher: s.net.fetcher, now: () => daytime, report: () => {} });
  await restarted.tick();
  assert.equal(s.net.sent.length, 2);
});

test('an overlapping cron cannot deliver a GPU twice', async () => {
  const s = setup();
  const first = s.monitor.tick();
  const second = await s.monitor.tick();
  assert.deepEqual(second, { status: 'skipped', reason: 'busy' });
  await first;
  assert.equal(s.net.sent.length, 2);
});

test('a failed channel retries after restart without resending the successful channel', async () => {
  const s = setup(); s.net.failWhatsApp = true;
  await assert.rejects(s.monitor.tick(), /Falha/);
  assert.equal(s.store.data.get('channel:telegram').cursor, 101);
  assert.equal(s.store.data.get('channel:whatsapp').cursor, 100);
  s.net.failWhatsApp = false;
  const restarted = new CloudMonitor(s.store, s.settings, { fetcher: s.net.fetcher, now: () => daytime, report: () => {} });
  await restarted.tick();
  assert.deepEqual(s.net.sent.map(x => x.channel), ['telegram', 'whatsapp']);
});

test('disabled, unknown modes and outside hours cannot make outbound requests', async () => {
  for (const mode of ['disabled', undefined, 'typo']) {
    const s = setup({ ...env(), MONITOR_MODE: mode });
    if (mode === 'typo') await assert.rejects(s.monitor.tick()); else await s.monitor.tick();
    assert.equal(s.net.reads.length + s.net.sent.length, 0);
  }
  for (const time of ['2026-11-14T09:59:59Z', '2026-11-15T02:00:00Z']) {
    const s = setup(env(), () => Date.parse(time));
    assert.equal((await s.monitor.tick()).reason, 'outside_hours');
    assert.equal(s.net.reads.length + s.net.sent.length, 0);
  }
});

test('dry-run reports matching offers without notifying or advancing either cursor', async () => {
  const s = setup({ MONITOR_MODE: 'dry-run' });
  const result = await s.monitor.tick();
  assert.equal(result.status, 'dry-run');
  assert.equal(result.matchingPosts, 1);
  assert.equal(s.net.sent.length, 0);
  assert.equal(s.store.data.has('channel:telegram'), false);
  assert.equal(s.store.data.has('channel:whatsapp'), false);
});

test('an explicit cloud test is sent once per channel and run id even after restart', async () => {
  const s = setup({ ...env(), MONITOR_MODE: 'test', TEST_RUN_ID: 'migration-20261114' }, () => 0);
  await s.monitor.tick();
  const restarted = new CloudMonitor(s.store, s.settings, { fetcher: s.net.fetcher, now: () => 0, report: () => {} });
  await restarted.tick();
  assert.equal(s.net.sent.length, 2);
  assert.match(s.net.sent[0].message.text, /Teste Hardware Bot.*Cloudflare/);
  assert.equal(s.net.reads.length, 0);
  assert.equal(s.store.data.has('channel:telegram'), false);
});

test('missing or malformed migration cursors do not skip pending posts', async () => {
  for (const seed of [undefined, '', '-1', '123abc']) {
    const s = setup({ ...env(), INITIAL_TELEGRAM_CURSOR: seed, INITIAL_WHATSAPP_CURSOR: seed });
    await assert.rejects(s.monitor.tick(), /Falha/);
    assert.equal(s.net.reads.length + s.net.sent.length, 0);
  }
});

test('one missing migration cursor blocks both channels before any delivery', async () => {
  for (const missing of ['INITIAL_TELEGRAM_CURSOR', 'INITIAL_WHATSAPP_CURSOR']) {
    const settings = env(); delete settings[missing];
    const s = setup(settings);
    await assert.rejects(s.monitor.tick(), /Falha/);
    assert.equal(s.net.reads.length + s.net.sent.length, 0);
  }
});

test('pagination stops before starting a new request after 23:00 and keeps posts pending', async () => {
  let now = Date.parse('2026-11-15T01:59:59Z');
  const store = storage(); let requests = 0;
  const monitor = new CloudMonitor(store, env(), { now: () => now, report: () => {}, fetcher: async url => {
    assert.match(String(url), /^https:\/\/t.me\/s\//);
    requests++;
    now = Date.parse('2026-11-15T02:00:01Z');
    return new Response('<div data-post="TJGOFERTASs/102"><div class="tgme_widget_message_text">RTX 5070 R$ 4.500,00</div><time datetime="2026-11-15T01:59:58Z"></time></div>');
  }});
  await monitor.tick();
  assert.equal(requests, 1);
  assert.equal(store.data.get('channel:telegram').cursor, 100);
  assert.equal(store.data.get('channel:whatsapp').cursor, 100);
});

test('persistence failures stop delivery and are not reported as healthy runs', async () => {
  const store = storage(); store.put = async () => { throw new Error('Disk unavailable'); };
  const s = setup(env(), () => daytime, store);
  await assert.rejects(s.monitor.tick(), /Falha/);
  assert.equal(s.net.sent.length, 0);
  assert.equal(s.reports.at(-1).status, 'failed');
});

test('transport errors are sanitized and never expose credentials in reports or thrown errors', async () => {
  const s = setup(); s.net.failWhatsApp = true;
  const error = await s.monitor.tick().catch(error => error);
  const output = JSON.stringify(s.reports) + String(error);
  assert.doesNotMatch(output, /test-key-123|5511999999999|abcdefghijklmnopqrstuvwx/);
  assert.equal(s.reports.at(-1).status, 'failed');
});
