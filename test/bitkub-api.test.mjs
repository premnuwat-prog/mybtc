import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignaturePayload,
  signRequest,
  normalizeBitkubOrder,
  fetchOrderHistory,
} from '../lib/bitkub-api.mjs';

test('buildSignaturePayload concatenates timestamp, method, and signed path', () => {
  assert.equal(
    buildSignaturePayload('1699381086593', 'GET', '/api/v3/market/my-order-history?sym=BTC_THB'),
    '1699381086593GET/api/v3/market/my-order-history?sym=BTC_THB',
  );
});

test('signRequest returns a lowercase HMAC-SHA256 hex digest', () => {
  assert.equal(
    signRequest('secret', '1699381086593GET/api/v3/market/my-order-history?sym=BTC_THB'),
    'd4356961c821c64d7ded8cad803e858d95ed10370946915bc1abb6a8ca14c74c',
  );
});

test('normalizeBitkubOrder converts a buy quote amount into BTC and THB', () => {
  assert.deepEqual(normalizeBitkubOrder({
    txn_id: 'buy-1', side: 'buy', rate: '2500000.00', amount: '1000.00', fee: '2.50', ts: 1755850086843,
  }), {
    id: 'buy-1', ts: 1755850086843, date: '2025-08-22T08:08:06.843Z', pair: 'BTC/THB',
    side: 'buy', btc: 0.0004, price: 2500000, thb: 1000, fee: 2.5, source: 'bitkub-api',
  });
});

test('normalizeBitkubOrder converts a sell base amount into BTC and THB', () => {
  assert.deepEqual(normalizeBitkubOrder({
    txn_id: 'sell-1', side: 'sell', rate: '2500000.00', amount: '0.0004', fee: '2.50', ts: 1755850086843,
  }), {
    id: 'sell-1', ts: 1755850086843, date: '2025-08-22T08:08:06.843Z', pair: 'BTC/THB',
    side: 'sell', btc: 0.0004, price: 2500000, thb: 1000, fee: 2.5, source: 'bitkub-api',
  });
});

test('fetchOrderHistory follows keyset pagination and signs every private request', async () => {
  const calls = [];
  const responses = [
    { body: 1700000000000 },
    { body: { error: 0, result: [{ txn_id: 'a', side: 'buy', rate: '2000000', amount: '1000', ts: 1700000000000 }], pagination: { cursor: 'next cursor', has_next: true } } },
    { body: 1700000001000 },
    { body: { error: 0, result: [{ txn_id: 'b', side: 'sell', rate: '2000000', amount: '0.0005', ts: 1700000001000 }], pagination: { cursor: '', has_next: false } } },
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    return { ok: true, status: 200, json: async () => next.body };
  };

  const trades = await fetchOrderHistory({ apiKey: 'key', apiSecret: 'secret', fetchImpl });

  assert.deepEqual(trades.map(t => t.id), ['a', 'b']);
  assert.equal(calls.length, 4);
  assert.equal(calls[1].options.headers['X-BTK-APIKEY'], 'key');
  assert.match(calls[1].options.headers['X-BTK-SIGN'], /^[a-f0-9]{64}$/);
  assert.match(calls[3].url, /cursor=next\+cursor/);
  assert.equal(calls[3].options.headers['X-BTK-TIMESTAMP'], '1700000001000');
});

test('fetchOrderHistory rejects Bitkub API errors without leaking credentials', async () => {
  const fetchImpl = async (url) => String(url).endsWith('/servertime')
    ? { ok: true, status: 200, json: async () => 1700000000000 }
    : { ok: true, status: 200, json: async () => ({ error: 6, result: null }) };

  await assert.rejects(
    fetchOrderHistory({ apiKey: 'super-key', apiSecret: 'super-secret', fetchImpl }),
    (error) => {
      assert.match(error.message, /Bitkub API error 6/);
      assert.doesNotMatch(error.message, /super-key|super-secret/);
      return true;
    },
  );
});
