export function isMonitoringTime(timestamp = Date.now()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp)));
  return hour >= 7 && hour < 23;
}

export function parseMoney(raw) {
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.replaceAll('.', '').split(',');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function advertisedPrice(text) {
  const candidates = [];
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(/R\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?)(?![\d.,])/gi)) {
      const before = line.slice(0, match.index).trim();
      if (/(?:^|\s)(?:de|era|antes)\s*[:\-]?\s*$/i.test(before) || /\d+\s*x\s*(?:de)?\s*$/i.test(before)) continue;
      if (/(?:cupom|desconto|cashback|frete)\s*(?::|de)?\s*$/i.test(before)) continue;
      const cents = parseMoney(match[1]);
      if (cents !== null) candidates.push(cents);
    }
  }
  return candidates.length ? Math.min(...candidates) : null;
}

function plainText(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
      if (entities[entity.toLowerCase()]) return entities[entity.toLowerCase()];
      const value = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : all;
    }).replace(/[ \t]+/g, ' ').trim();
}

export function parseFeed(html, channel) {
  const markers = [...html.matchAll(/\bdata-post="([A-Za-z0-9_]+)\/(\d+)"/g)];
  const result = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (marker[1].toLowerCase() !== channel.toLowerCase()) continue;
    const chunk = html.slice(marker.index, markers[i + 1]?.index ?? html.length);
    const body = chunk.match(/<div\b[^>]*class="[^"]*\btgme_widget_message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const date = chunk.match(/<time\b[^>]*datetime="([^"]+)"/i)?.[1];
    const id = Number(marker[2]);
    if (!Number.isSafeInteger(id) || !date || !Number.isFinite(Date.parse(date))) continue;
    result.push({ id, text: body ? plainText(body[1]) : '', date, url: `https://t.me/${channel}/${id}` });
  }
  return [...new Map(result.map(p => [p.id, p])).values()].sort((a, b) => a.id - b.id);
}

export function matchOffers(post, rules) {
  const price = advertisedPrice(post.text);
  if (price === null || /\b(?:pc\s+gamer|computador\s+completo|notebook)\b/i.test(post.text)) return [];
  const matching = rules.filter(rule => new RegExp(rule.pattern, 'iu').test(post.text)
    && (!rule.exclude || !new RegExp(rule.exclude, 'iu').test(post.text)));
  // A multi-product ad has no reliable association between its prices and components.
  if (matching.length !== 1) return [];
  return matching.filter(rule => price <= Math.round(rule.max * 100)).map(rule => ({ rule, price }));
}

export async function processPosts(posts, previous, rules, options) {
  const { send, checkpoint = async () => {}, now = Date.now() } = options;
  if (!posts.length) throw new Error('A previa do canal nao retornou publicacoes reconheciveis; cursor preservado.');
  const sorted = [...posts].sort((a, b) => a.id - b.id);
  if (!previous) {
    const initial = { cursor: sorted.at(-1).id, delivered: [] };
    await checkpoint(initial);
    return initial;
  }
  if (!Number.isSafeInteger(previous.cursor) || previous.cursor < 0 || !Array.isArray(previous.delivered)) {
    throw new Error('Estado invalido; nao reinicializar silenciosamente.');
  }
  const state = structuredClone(previous);
  for (const post of sorted.filter(p => p.id > state.cursor)) {
    const age = now - Date.parse(post.date);
    if (!Number.isFinite(age)) throw new Error('Data da publicacao invalida.');
    if (age >= -300_000 && age <= 172_800_000) {
      for (const offer of matchOffers(post, rules)) {
        const key = `${post.id}:${offer.rule.id}`;
        if (state.delivered.includes(key)) continue;
        await send(post, offer);
        state.delivered.push(key);
        await checkpoint(state);
      }
    }
    state.cursor = post.id;
    state.delivered = state.delivered.filter(key => Number(key.split(':')[0]) > state.cursor);
    await checkpoint(state);
  }
  return state;
}

export async function fetchPosts(channel, cursor, fetcher = fetch) {
  if (!/^[A-Za-z0-9_]{5,32}$/.test(channel)) throw new Error('Canal invalido.');
  const all = new Map();
  let before;
  for (let page = 0; page < 10; page++) {
    const url = `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Previa do canal indisponivel (HTTP ${response.status}).`);
    const posts = parseFeed(await response.text(), channel);
    if (!posts.length) throw new Error('Pagina sem publicacoes reconheciveis.');
    for (const post of posts) all.set(post.id, post);
    const oldest = posts[0].id;
    if (cursor === undefined || oldest <= cursor) return [...all.values()];
    if (before !== undefined && oldest >= before) throw new Error('Paginacao do canal nao avancou.');
    before = oldest;
  }
  throw new Error('Mais de dez paginas pendentes; cursor preservado para verificacao.');
}

export function alertText(post, offer) {
  const amount = (offer.price / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const coupon = post.text.match(/cupom\s*:?\s*[`"']?([A-Za-z0-9_-]{3,40})/i)?.[1];
  return `${offer.rule.name} por ${amount}!\n${coupon ? `Cupom anunciado: ${coupon}\n` : ''}${post.url}\n\nPreco anunciado pela TJGaming; confira as condicoes e o frete no link da publicacao.`;
}

export async function sendTelegram(text, token, chatId, fetcher = fetch) {
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token ?? '') || !/^\d+$/.test(chatId ?? '')
      || !Number.isSafeInteger(Number(chatId)) || Number(chatId) <= 0) throw new Error('Segredos Telegram ausentes ou invalidos.');
  let response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: false, protect_content: true, link_preview_options: { is_disabled: true } }),
    });
  } catch { throw new Error('Conexao de envio falhou; aceite pelo Telegram desconhecido. Nenhum segredo foi registrado.'); }
  if (!response.ok) throw new Error(`Telegram recusou o envio (HTTP ${response.status}).`);
  let body;
  try { body = await response.json(); } catch { throw new Error('Resposta do Telegram invalida.'); }
  if (!body.ok || body.result?.chat?.type !== 'private' || String(body.result.chat.id) !== chatId) {
    throw new Error('Telegram nao confirmou a entrega na conversa privada pareada.');
  }
}
