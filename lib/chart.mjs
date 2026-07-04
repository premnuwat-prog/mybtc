// สร้างชุดข้อมูลกราฟรายวัน: ราคา BTC/THB จาก Bitkub + EMA12/26 + on-chain (MVRV, STH/LTH Realized Price)
// ใช้ร่วมกันระหว่างเซิร์ฟเวอร์ local และ GitHub Action (พึ่งแค่ fetch ไม่มี dependency อื่น)

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return values.map((v) => {
    if (v == null) return prev;
    prev = prev == null ? v : v * k + prev * (1 - k);
    return prev;
  });
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { accept: 'application/json', 'user-agent': 'my-btc-cost/1.0' } });
  if (!r.ok) throw new Error(`${new URL(url).host} ตอบ ${r.status}`);
  return r.json();
}

export async function buildChart() {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 86400 * 1461; // ~4 ปี (เท่าที่ bitcoin-data.com ให้ฟรี)
  const bk = await fetchJson(`https://api.bitkub.com/tradingview/history?symbol=BTC_THB&resolution=1D&from=${from}&to=${now}`);
  if (!Array.isArray(bk.t) || !bk.t.length) throw new Error('Bitkub ไม่ส่งราคาย้อนหลังมา');
  const dayKey = (tsSec) => new Date(tsSec * 1000).toISOString().slice(0, 10);
  const days = bk.t.map((t, i) => ({ d: dayKey(t), ts: t * 1000, price: bk.c[i] }));

  // ข้อมูล on-chain เป็น USD — แปลงเป็น THB ด้วยอัตราแฝง (ราคา Bitkub ÷ ราคา USD วันเดียวกัน)
  let onchain = null;
  try {
    const [mvrv, sth, lth, usd] = await Promise.all([
      fetchJson('https://bitcoin-data.com/v1/mvrv'),
      fetchJson('https://bitcoin-data.com/v1/sth-realized-price'),
      fetchJson('https://bitcoin-data.com/v1/lth-realized-price'),
      fetchJson('https://bitcoin-data.com/v1/btc-price'),
    ]);
    const toMap = (arr, field) => new Map(arr.map(r => [r.d, Number(r[field])]));
    onchain = {
      mvrv: toMap(mvrv, 'mvrv'), sth: toMap(sth, 'sthRealizedPrice'),
      lth: toMap(lth, 'lthRealizedPrice'), usd: toMap(usd, 'btcPrice'),
    };
  } catch (e) {
    console.error('ดึงข้อมูล on-chain ไม่ได้ (แสดงเฉพาะราคา+EMA):', e.message);
  }

  const ema12 = ema(days.map(d => d.price), 12);
  const ema26 = ema(days.map(d => d.price), 26);
  let last = { rate: null, mvrv: null, sthUsd: null, lthUsd: null, stale: 0 };
  days.forEach((d, i) => {
    d.ema12 = round2(ema12[i]);
    d.ema26 = round2(ema26[i]);
    d.mvrv = null; d.sth = null; d.lth = null;
    if (!onchain) return;
    const usd = onchain.usd.get(d.d);
    if (usd) {
      last = { rate: d.price / usd, mvrv: onchain.mvrv.get(d.d) ?? last.mvrv, sthUsd: onchain.sth.get(d.d) ?? last.sthUsd, lthUsd: onchain.lth.get(d.d) ?? last.lthUsd, stale: 0 };
    } else last.stale++;
    if (last.rate && last.stale <= 3) { // เติมค่าล่าสุดให้วันท้ายๆ ที่ on-chain ยังไม่อัปเดต
      d.mvrv = last.mvrv;
      d.sth = round2(last.sthUsd * last.rate);
      d.lth = round2(last.lthUsd * last.rate);
    }
  });
  return { builtAt: Date.now(), onchainOk: !!onchain, days };
}
