import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fetchPosts, matchOffers, alertText, sendTelegram, sendWhatsApp, validateWhatsApp, monitorChannels, isMonitoringTime } from './monitor.mjs';

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
    const target = process.env.TEST_CHANNEL || 'telegram';
    if (!['telegram', 'whatsapp', 'both'].includes(target)) throw new Error('Canal de teste invalido.');
    if (target === 'telegram' || target === 'both') {
      await sendTelegram('Teste na nuvem: o GitHub Actions enviou esta mensagem ao seu Telegram. Seu computador pode ficar desligado.', process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
      console.log('Teste aceito pelo Telegram na conversa privada.');
    }
    if (target === 'whatsapp' || target === 'both') {
      await sendWhatsApp('Teste Hardware Bot: os alertas de componente, preco e link estao conectados ao WhatsApp pela nuvem. https://t.me/TJGOFERTASs', process.env.WHATSAPP_PHONE, process.env.CALLMEBOT_API_KEY);
      console.log('Teste aceito pelo CallMeBot. Confirme o recebimento no WhatsApp.');
    }
    return;
  }
  if (!isMonitoringTime()) {
    console.log('Fora do horario de monitoramento: 07:00 a 23:00, America/Sao_Paulo.');
    return;
  }
  if (process.argv.includes('--dry-run')) {
    const posts = await fetchPosts(config.channel);
    console.log(JSON.stringify({ channel: config.channel, posts: posts.length, oldest: Math.min(...posts.map(p => p.id)), latest: Math.max(...posts.map(p => p.id)), matchingPosts: posts.filter(p => matchOffers(p, config.rules).length).length, sent: 0 }));
    return;
  }
  const channels = [{ id: 'telegram',
    validate: () => {
      if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) throw new Error('Segredos Telegram ausentes.');
    },
    send: (post, offer) => sendTelegram(alertText(post, offer), process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID),
  }];
  if (process.env.WHATSAPP_PHONE || process.env.CALLMEBOT_API_KEY) {
    channels.push({ id: 'whatsapp',
      validate: () => validateWhatsApp(process.env.WHATSAPP_PHONE, process.env.CALLMEBOT_API_KEY),
      send: (post, offer) => sendWhatsApp(alertText(post, offer), process.env.WHATSAPP_PHONE, process.env.CALLMEBOT_API_KEY),
    });
  }
  const statePath = id => id === 'telegram' ? '.state/cursor.json' : '.state/whatsapp.json';
  await monitorChannels(channels, config, {
    loadState: async id => {
      try { return JSON.parse(await readFile(statePath(id), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Estado persistido invalido.'); }
    },
    saveState: async (id, state) => {
      await mkdir('.state', { recursive: true });
      await writeFile(statePath(id) + '.tmp', JSON.stringify(state), { mode: 0o600 });
      await rename(statePath(id) + '.tmp', statePath(id));
    },
    report: result => console.log(JSON.stringify(result)),
  });
}

main().catch(error => {
  if (error.code === 'OUTSIDE_MONITORING_HOURS') { console.log(error.message); return; }
  console.error(error.message);
  process.exitCode = 1;
});
