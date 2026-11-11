import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, advertisedPrice, parseFeed, matchOffers, processPosts, fetchPosts, sendTelegram } from '../src/monitor.mjs';

const rules = [
  { id: '5070', name: 'RTX 5070', pattern: '\\brtx[ \\-]*5070\\b', exclude: '\\b5070\\s*ti\\b', max: 4500 },
  { id: '9070', name: 'RX 9070', pattern: '\\brx[ \\-]*9070\\b', exclude: '\\b9070\\s*(?:xt|gre)\\b', max: 4500 },
];
const now = Date.parse('2026-11-11T23:00:00Z');
const post = (id, text = 'Placa RTX 5070 por R$ 4.031,00') => ({ id, text, date: '2026-11-11T22:00:00Z', url: `https://t.me/TJGOFERTASs/${id}` });

test('reads Brazilian reais including grouped thousands and cents', () => {
  assert.equal(parseMoney('4.031,99'), 403199);
  assert.equal(parseMoney('4031'), 403100);
  assert.equal(parseMoney('999,9'), 99990);
  assert.equal(parseMoney('4.031'), 403100);
});

test('does not mistake installments, former prices or coupon amounts for the advertised price', () => {
  assert.equal(advertisedPrice('De R$ 6.000 por R$ 4.031\n12x de R$ 399\nCupom de R$ 100'), 403100);
  assert.equal(advertisedPrice('12x de R$ 399,00\nUse o cupom'), null);
  assert.equal(advertisedPrice('Era R$ 3.000\nAgora R$ 4.800'), 480000);
  assert.equal(advertisedPrice('De: R$ 3.000\nPor R$ 4.800\nDesconto: R$ 100'), 480000);
  assert.equal(advertisedPrice('R$ 4,031'), null);
});

test('matches an inclusive threshold and rejects a different GPU variant', () => {
  assert.equal(matchOffers(post(1, 'RTX 5070 R$ 4.500'), rules).length, 1);
  assert.equal(matchOffers(post(1, 'RTX 5070 R$ 4.500,01'), rules).length, 0);
  assert.equal(matchOffers(post(1, 'RTX 5070 Ti R$ 4.000'), rules).length, 0);
  assert.equal(matchOffers(post(1, 'RX 9070 GRE R$ 4.000'), rules).length, 0);
  assert.equal(matchOffers(post(1, 'RX 9070 XT R$ 4.000'), rules).length, 0);
  assert.equal(matchOffers(post(1, 'RX 9070 R$ 4.000'), rules)[0].rule.id, '9070');
});

test('parses public preview post ids, entities, dates and formatted offer text', () => {
  const html = '<div class="tgme_widget_message js-widget_message" data-post="TJGOFERTASs/123">'
    + '<div class="tgme_widget_message_text js-message_text"><b>RTX 5070</b><br/>R$ 4.031 &amp; cupom</div>'
    + '<a class="tgme_widget_message_date"><time datetime="2026-11-11T22:00:00+00:00">19:00</time></a></div>';
  const [actual] = parseFeed(html, 'TJGOFERTASs');
  assert.deepEqual(actual, { id: 123, text: 'RTX 5070\nR$ 4.031 & cupom', date: '2026-11-11T22:00:00+00:00', url: 'https://t.me/TJGOFERTASs/123' });
});

test('initializes without sending historical messages', async () => {
  let sent = 0;
  const state = await processPosts([post(3), post(4)], null, rules, { now, send: async () => sent++ });
  assert.equal(sent, 0);
  assert.equal(state.cursor, 4);
});

test('sends a matching new post once and ignores above-threshold and old posts', async () => {
  const sent = [];
  const state = await processPosts([post(1), post(2), post(3, 'RTX 5070 R$ 5.000'), { ...post(4), date: '2026-08-10T10:00:00Z' }], { cursor: 1, delivered: [] }, rules, { now, send: async p => sent.push(p.id) });
  assert.deepEqual(sent, [2]);
  await processPosts([post(2), post(3)], state, rules, { now, send: async () => assert.fail('duplicate') });
  assert.equal(state.cursor, 4);
});

test('does not advance past a failed send and persists partial delivery for retry', async () => {
  const checkpoints = [];
  await assert.rejects(processPosts([post(2), post(3)], { cursor: 1, delivered: [] }, rules, {
    now, checkpoint: async state => checkpoints.push(structuredClone(state)),
    send: async p => { if (p.id === 3) throw new Error('offline'); },
  }), /offline/);
  const last = checkpoints.at(-1);
  assert.equal(last.cursor, 2);
  const retried = [];
  await processPosts([post(2), post(3)], last, rules, { now, send: async p => retried.push(p.id) });
  assert.deepEqual(retried, [3]);
});

test('paginates public preview backwards until it reaches the previous cursor', async () => {
  const calls = [];
  const html = id => `<div data-post="TJGOFERTASs/${id}"><div class="tgme_widget_message_text">RTX 5070 R$ 4.000</div><time datetime="2026-11-11T22:00:00Z"></time></div>`;
  const posts = await fetchPosts('TJGOFERTASs', 1, async url => {
    calls.push(url);
    return new Response(calls.length === 1 ? html(3) + html(4) : html(1) + html(2));
  });
  assert.deepEqual(calls, ['https://t.me/s/TJGOFERTASs', 'https://t.me/s/TJGOFERTASs?before=3']);
  assert.deepEqual(posts.map(p => p.id).sort(), [1, 2, 3, 4]);
});

test('rejects unrecognizable feeds and corrupt state rather than sending historical ads', async () => {
  await assert.rejects(fetchPosts('TJGOFERTASs', 1, async () => new Response('<html>blocked</html>')), /sem publicacoes/);
  await assert.rejects(processPosts([post(2)], { cursor: 'bad', delivered: [] }, rules, { now }), /Estado invalido/);
});

test('sends only to a positive private chat id and does not leak a token on HTTP failure', async () => {
  const token = '123456:abcdefghijklmnopqrstuvwxyz_123';
  await assert.rejects(sendTelegram('test', token, '-100123'), /invalidos/);
  let body;
  await sendTelegram('test', token, '123', async (_, options) => {
    body = JSON.parse(options.body);
    return Response.json({ ok: true, result: { chat: { id: 123, type: 'private' } } });
  });
  assert.equal(body.chat_id, '123');
  assert.equal(body.disable_notification, false);
  assert.equal(body.text, 'test');
  await assert.rejects(sendTelegram('test', token, '123', async () => { throw new Error(`secret ${token}`); }), error => !error.message.includes(token) && /Conexao/.test(error.message));
  await assert.rejects(sendTelegram('test', token, '123', async () => Response.json({ ok: true, result: { chat: { id: 456, type: 'private' } } })), /nao confirmou/);
});
