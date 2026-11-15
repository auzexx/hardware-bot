import config from '../rules.json' with { type: 'json' };
import { alertText, fetchPosts, isMonitoringTime, matchOffers, monitorChannels, sendTelegram, sendWhatsApp, validateWhatsApp } from './monitor.mjs';

export class CloudMonitor {
  constructor(storage, env, { fetcher = fetch, now = Date.now, report = value => console.log(JSON.stringify(value)) } = {}) {
    this.storage = storage;
    this.env = env;
    // Workers fetch requires its global receiver, not the CloudMonitor instance.
    this.fetcher = (...args) => fetcher(...args);
    this.now = now;
    this.report = report;
    this.running = false;
  }

  async tick() {
    if (this.running) return { status: 'skipped', reason: 'busy' };
    this.running = true;
    const started = this.now();
    try {
      const mode = this.env.MONITOR_MODE || 'disabled';
      let result;
      if (mode === 'disabled') result = { status: 'disabled' };
      else if (!['live', 'dry-run', 'test'].includes(mode)) throw new Error('Modo invalido.');
      else if (mode !== 'test' && !isMonitoringTime(this.now())) result = { status: 'skipped', reason: 'outside_hours' };
      else if (mode === 'dry-run') {
        const posts = await this.fetchFeed(config.channel);
        result = { status: 'dry-run', postsChecked: posts.length, latest: Math.max(...posts.map(post => post.id)),
          matchingPosts: posts.filter(post => matchOffers(post, config.rules).length > 0).length, sent: 0 };
      } else {
        const channels = this.channels();
        if (mode === 'test') result = await this.test(channels);
        else {
          // Finish cutover preflight for BOTH channels before any feed or delivery.
          const previousStates = new Map();
          for (const channel of channels) previousStates.set(channel.id, await this.loadChannel(channel.id));
          const feeds = new Map();
          const results = await monitorChannels(channels, config, {
            now: this.now(), canSend: () => isMonitoringTime(this.now()),
            loadState: async id => previousStates.get(id),
            saveState: (id, state) => this.storage.put(`channel:${id}`, state),
            fetchChannelPosts: (channel, cursor) => {
              if (!feeds.has(cursor)) feeds.set(cursor, this.fetchFeed(channel, cursor));
              return feeds.get(cursor);
            },
            report: this.report,
          });
          result = { status: 'ok', channels: results };
        }
      }
      this.report({ ...result, startedAt: new Date(started).toISOString(), durationMs: this.now() - started });
      return result;
    } catch {
      // Transport exceptions can contain secret-bearing URLs. Never log them.
      this.report({ status: 'failed', startedAt: new Date(started).toISOString(), durationMs: this.now() - started });
      throw new Error('Falha no monitor Cloudflare. Consulte os logs sanitizados.');
    } finally {
      this.running = false;
    }
  }

  channels() {
    const env = this.env;
    return [
      { id: 'telegram', validate: () => {
        if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(env.TELEGRAM_BOT_TOKEN || '') || !/^\d+$/.test(env.TELEGRAM_CHAT_ID || '')
          || !Number.isSafeInteger(Number(env.TELEGRAM_CHAT_ID)) || Number(env.TELEGRAM_CHAT_ID) <= 0) throw new Error('Credenciais Telegram invalidas.');
      }, send: (post, offer) => sendTelegram(alertText(post, offer), env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, this.fetcher),
      sendTest: text => sendTelegram(text, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, this.fetcher) },
      { id: 'whatsapp', validate: () => validateWhatsApp(env.WHATSAPP_PHONE, env.CALLMEBOT_API_KEY),
        send: (post, offer) => sendWhatsApp(alertText(post, offer), env.WHATSAPP_PHONE, env.CALLMEBOT_API_KEY, this.fetcher),
        sendTest: text => sendWhatsApp(text, env.WHATSAPP_PHONE, env.CALLMEBOT_API_KEY, this.fetcher) },
    ];
  }

  fetchFeed(channel, cursor) {
    return fetchPosts(channel, cursor, (url, init) => {
      if (!isMonitoringTime(this.now())) {
        const error = new Error('Horario de monitoramento encerrado.');
        error.code = 'OUTSIDE_MONITORING_HOURS';
        throw error;
      }
      return this.fetcher(url, init);
    });
  }

  async loadChannel(id) {
    const key = `channel:${id}`;
    const existing = await this.storage.get(key);
    if (existing !== undefined && existing !== null) {
      if (!Number.isSafeInteger(existing.cursor) || existing.cursor < 0 || !Array.isArray(existing.delivered)) throw new Error('Estado persistido invalido.');
      return existing;
    }
    const seed = this.env[`INITIAL_${id.toUpperCase()}_CURSOR`];
    if (!/^[1-9]\d*$/.test(seed || '') || !Number.isSafeInteger(Number(seed))) throw new Error('Cursor de migracao obrigatorio.');
    const initial = { cursor: Number(seed), delivered: [] };
    await this.storage.put(key, initial);
    return initial;
  }

  async test(channels) {
    const runId = this.env.TEST_RUN_ID;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId || '')) throw new Error('Identificador de teste obrigatorio.');
    let feed;
    if (this.env.TEST_READ_FEED === 'true') {
      const key = `test:${runId}:feed`;
      feed = await this.storage.get(key);
      if (!feed) {
        // Explicit diagnostic only: no matching, deliveries or live cursor changes.
        const posts = await fetchPosts(config.channel, undefined, this.fetcher);
        feed = { postsChecked: posts.length, latest: Math.max(...posts.map(post => post.id)) };
        await this.storage.put(key, feed);
      }
    }
    const results = [], failed = [];
    for (const channel of channels) {
      try {
        channel.validate();
        const key = `test:${runId}:${channel.id}`;
        if (await this.storage.get(key)) { results.push({ channel: channel.id, sent: 0 }); continue; }
        await channel.sendTest(`Teste Hardware Bot na Cloudflare: envio privado funcionando. Consultas programadas a cada minuto, das 7h as 23h. Teste: ${runId}`);
        await this.storage.put(key, { acceptedAt: this.now() });
        results.push({ channel: channel.id, sent: 1 });
      } catch { failed.push(channel.id); }
    }
    if (failed.length) throw new Error('Teste incompleto.');
    return { status: 'test', channels: results, ...(feed ? { feed } : {}) };
  }
}
