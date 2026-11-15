import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';

test('real Cloudflare runtime can read the public feed in dry-run without delivering alerts', async () => {
  const bundle = await readFile(new URL('../dist/worker.js', import.meta.url), 'utf8');
  // Fix only the simulator clock so this check also runs outside monitoring hours.
  const script = `Date.now = () => 1794668400000;\n${bundle}`;
  const requests = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: '2026-11-14', unsafeTriggerHandlers: true,
    durableObjects: { MONITOR: { className: 'HardwareMonitor', useSQLite: true } },
    bindings: { MONITOR_MODE: 'dry-run' },
    outboundService: async request => {
      requests.push(request.url);
      assert.equal(request.url, 'https://t.me/s/TJGOFERTASs');
      return new RuntimeResponse('<div data-post="TJGOFERTASs/101"><div class="tgme_widget_message_text">RTX 5070 12GB<br>R$ 4.500,00</div><time datetime="2026-11-14T14:59:00Z"></time></div>');
    },
  }));
  try {
    const result = await mf.dispatchFetch('http://localhost/cdn-cgi/local/scheduled?cron=*+10+*+*+*');
    assert.equal(await result.text(), 'ok');
    assert.deepEqual(requests, ['https://t.me/s/TJGOFERTASs']);
  } finally { await mf.dispose(); }
});

test('real Cloudflare runtime persists a one-shot test and public URLs cannot send messages', async () => {
  const bundle = await readFile(new URL('../dist/worker.js', import.meta.url), 'utf8');
  const script = `Date.now = () => 1794708600000;\n${bundle}`;
  const deliveries = [], requests = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: '2026-11-14', unsafeTriggerHandlers: true,
    durableObjects: { MONITOR: { className: 'HardwareMonitor', useSQLite: true } },
    bindings: { MONITOR_MODE: 'test', TEST_RUN_ID: 'local-runtime-test', TEST_READ_FEED: 'true',
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwx', TELEGRAM_CHAT_ID: '123456789',
      WHATSAPP_PHONE: '+5511999999999', CALLMEBOT_API_KEY: 'test-key-123' },
    outboundService: async request => {
      const url = new URL(request.url);
      requests.push({ host: url.hostname, method: request.method });
      if (url.hostname === 't.me') {
        assert.equal(url.pathname, '/s/TJGOFERTASs');
        return new RuntimeResponse('<div data-post="TJGOFERTASs/101"><div class="tgme_widget_message_text">RTX 5070 12GB<br>R$ 4.500,00</div><time datetime="2026-11-14T14:59:00Z"></time></div>');
      }
      if (url.hostname === 'api.telegram.org') {
        const body = await request.json();
        assert.equal(body.chat_id, '123456789');
        deliveries.push({ channel: 'telegram', text: body.text });
        return new RuntimeResponse(JSON.stringify({ ok: true, result: { chat: { type: 'private', id: 123456789 } } }), { headers: { 'content-type': 'application/json' } });
      }
      assert.equal(url.hostname, 'api.callmebot.com');
      deliveries.push({ channel: 'whatsapp', text: url.searchParams.get('text') });
      return new RuntimeResponse('Message queued');
    },
  }));
  try {
    for (const path of ['/', '/tick', '/test', '/?mode=test']) {
      assert.equal((await mf.dispatchFetch(`https://bot.example${path}`)).status, 404);
    }
    assert.equal(deliveries.length, 0);
    const first = await mf.dispatchFetch('http://localhost/cdn-cgi/local/scheduled?cron=*+10+*+*+*');
    assert.equal(await first.text(), 'ok', JSON.stringify({ requests, deliveries }));
    assert.deepEqual(deliveries.map(x => x.channel), ['telegram', 'whatsapp']);
    assert.match(deliveries[0].text, /Cloudflare/);
    const second = await mf.dispatchFetch('http://localhost/cdn-cgi/local/scheduled?cron=*+10+*+*+*');
    assert.equal(await second.text(), 'ok');
    assert.equal(deliveries.length, 2);
    assert.equal(requests.filter(request => request.host === 't.me').length, 1);
  } finally { await mf.dispose(); }
});
