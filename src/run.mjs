import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fetchPosts, processPosts, matchOffers, alertText, sendTelegram } from './monitor.mjs';

async function main() {
  const config = JSON.parse(await readFile(new URL('../rules.json', import.meta.url), 'utf8'));
  const ids = new Set();
  for (const rule of config.rules) {
    if (!rule.id || ids.has(rule.id) || !rule.name || !Number.isFinite(rule.max) || rule.max <= 0) throw new Error('Regra de preco invalida.');
    ids.add(rule.id);
    new RegExp(rule.pattern, 'iu');
    if (rule.exclude) new RegExp(rule.exclude, 'iu');
  }
  if (process.env.TEST_MESSAGE === 'true') {
    await sendTelegram('Teste na nuvem: o GitHub Actions enviou esta mensagem ao seu Telegram. Seu computador pode ficar desligado.', process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
    console.log('Teste aceito pelo Telegram na conversa privada.');
    return;
  }
  let previous = null;
  try { previous = JSON.parse(await readFile('.state/cursor.json', 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Nao foi possivel ler o estado persistido.'); }
  const posts = await fetchPosts(config.channel, previous?.cursor);
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ channel: config.channel, posts: posts.length, oldest: Math.min(...posts.map(p => p.id)), latest: Math.max(...posts.map(p => p.id)), matchingPosts: posts.filter(p => matchOffers(p, config.rules).length).length, sent: 0 }));
    return;
  }
  // Validate credentials even on a run with no offers: setup errors must not stay hidden.
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) throw new Error('Cadastre os dois segredos Telegram antes de ativar.');
  let sent = 0;
  const state = await processPosts(posts, previous, config.rules, {
    send: async (post, offer) => {
      await sendTelegram(alertText(post, offer), process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
      sent++;
    },
    checkpoint: async state => {
      await mkdir('.state', { recursive: true });
      await writeFile('.state/cursor.tmp', JSON.stringify(state), { mode: 0o600 });
      await rename('.state/cursor.tmp', '.state/cursor.json');
    },
  });
  console.log(JSON.stringify({ postsChecked: posts.length, sent, cursor: state.cursor, initialized: previous === null }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
