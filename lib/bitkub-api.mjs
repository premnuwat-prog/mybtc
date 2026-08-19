import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.bitkub.com';
const HISTORY_PATH = '/api/v3/market/my-order-history';
const SERVER_TIME_PATH = '/api/v3/servertime';

export function buildSignaturePayload(timestamp, method, signedPath, body = '') {
  return `${timestamp}${method.toUpperCase()}${signedPath}${body}`;
}

export function signRequest(apiSecret, payload) {
  return crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
}

function round(value, digits) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

export function normalizeBitkubOrder(order) {
  const side = String(order?.side ?? '').toLowerCase();
  const price = Number(order?.rate);
  const amount = Number(order?.amount);
  const ts = Number(order?.ts ?? order?.order_closed_at);
  if (!['buy', 'sell'].includes(side) || !Number.isFinite(price) || price <= 0
      || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(ts)) return null;

  // Bitkub V3: amount is quote currency (THB) for buy, base currency (BTC) for sell.
  const btc = side === 'buy' ? amount / price : amount;
  const thb = side === 'buy' ? amount : amount * price;
  const fee = Number(order?.fee);
  return {
    id: String(order.txn_id ?? order.order_id),
    ts,
    date: new Date(ts).toISOString(),
    pair: 'BTC/THB',
    side,
    btc: round(btc, 8),
    price: round(price, 2),
    thb: round(thb, 2),
    fee: Number.isFinite(fee) ? round(fee, 8) : 0,
    source: 'bitkub-api',
  };
}

async function readJson(response, label) {
  let body;
  try { body = await response.json(); } catch { throw new Error(`${label}: invalid JSON response`); }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return body;
}

async function getServerTime(baseUrl, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}${SERVER_TIME_PATH}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readJson(response, 'Bitkub server time');
  const timestamp = Number(body?.serverTime ?? body?.result ?? body);
  if (!Number.isFinite(timestamp)) throw new Error('Bitkub server time: invalid timestamp');
  return String(timestamp);
}

export async function fetchOrderHistory({
  apiKey,
  apiSecret,
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE_URL,
  symbol = 'BTC_THB',
  limit = 100,
  maxPages = 100,
} = {}) {
  if (!apiKey || !apiSecret) {
    throw new Error('ยังไม่ได้ตั้งค่า BITKUB_API_KEY และ BITKUB_API_SECRET');
  }

  const orders = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({
      sym: symbol,
      lmt: String(limit),
      pagination_type: 'keyset',
    });
    if (cursor) query.set('cursor', cursor);
    const signedPath = `${HISTORY_PATH}?${query}`;
    const timestamp = await getServerTime(baseUrl, fetchImpl);
    const payload = buildSignaturePayload(timestamp, 'GET', signedPath);
    const signature = signRequest(apiSecret, payload);

    const response = await fetchImpl(`${baseUrl}${signedPath}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-BTK-APIKEY': apiKey,
        'X-BTK-TIMESTAMP': timestamp,
        'X-BTK-SIGN': signature,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readJson(response, 'Bitkub order history');
    if (Number(body?.error) !== 0) throw new Error(`Bitkub API error ${body?.error ?? 'unknown'}`);
    if (!Array.isArray(body.result)) throw new Error('Bitkub order history: invalid result');
    orders.push(...body.result);

    if (!body.pagination?.has_next) break;
    cursor = body.pagination?.cursor;
    if (!cursor) throw new Error('Bitkub order history: missing next cursor');
    if (page === maxPages - 1) throw new Error(`Bitkub order history exceeded ${maxPages} pages`);
  }

  return orders.map(normalizeBitkubOrder).filter(Boolean);
}
