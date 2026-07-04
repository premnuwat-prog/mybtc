// ตัวช่วยกลาง: แปลงข้อมูลดิบจากหลายแหล่ง (JSON ที่ดักจับจากหน้าเว็บ / CSV) ให้เป็น
// รายการเทรดรูปแบบเดียวกัน แล้วคำนวณต้นทุนแบบถัวเฉลี่ย (average cost)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.join(ROOT, 'data');
export const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
export const RAW_DIR = path.join(DATA_DIR, 'raw');

// trade ที่ normalize แล้ว:
// { id, ts, date, pair, side: 'buy'|'sell', btc, price, thb, fee, source }

export function num(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,฿\s]/g, '').replace(/THB|BTC|บาท/gi, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function pick(o, keys) {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

function parseSide(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (/(buy|bid|ซื้อ)/.test(s) && !/ขาย|sell/.test(s)) return 'buy';
  if (/(sell|ask|ขาย)/.test(s)) return 'sell';
  return null;
}

function parseTs(o) {
  const raw = pick(o, ['ts', 'timestamp', 'time', 'date', 'created_at', 'createdat', 'created', 'datetime', 'txn_date']);
  if (raw == null) return NaN;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    let n = Number(raw);
    if (n < 1e11) n *= 1000; // วินาที -> มิลลิวินาที
    return n;
  }
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : NaN;
}

export function makeId(t) {
  return crypto.createHash('sha1')
    .update(`${t.ts}|${t.side}|${t.price}|${t.btc}`)
    .digest('hex').slice(0, 16);
}

// พยายามตีความ object หนึ่งตัว (จาก JSON ที่ดักจับได้) ว่าเป็นรายการเทรด BTC หรือไม่
export function parseTradeObject(raw, source = 'scrape') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = {};
  for (const [k, v] of Object.entries(raw)) o[k.toLowerCase()] = v;

  const sym = String(pick(o, ['sym', 'symbol', 'pair', 'coin', 'coin_name', 'asset', 'currency']) ?? '');
  if (sym && !/btc/i.test(sym)) return null; // ระบุเหรียญแต่ไม่ใช่ BTC -> ข้าม

  const side = parseSide(pick(o, ['side', 'type', 'typ', 'action', 'order_type', 'txn_type', 'transaction_type']));
  if (!side) return null;

  const price = num(pick(o, ['rate', 'price', 'avg_price', 'average_price', 'matched_rate']));
  if (!Number.isFinite(price) || price < 1000) return null; // ราคา BTC เป็น THB ควร > 1,000

  let btc = num(pick(o, ['base_amount', 'crypto_amount', 'coin_amount', 'btc_amount', 'filled', 'executed_amount', 'volume', 'qty', 'quantity']));
  let thb = num(pick(o, ['quote_amount', 'fiat_amount', 'thb_amount', 'total', 'value', 'cost']));
  const amount = num(pick(o, ['amount']));
  const receive = num(pick(o, ['receive', 'received', 'receive_amount']));

  // Bitkub: ฝั่ง buy มักระบุ amount เป็น THB ที่จ่าย และ receive เป็นเหรียญที่ได้
  //         ฝั่ง sell มักระบุ amount เป็นเหรียญที่ขาย และ receive เป็น THB ที่ได้
  if (!Number.isFinite(btc) || !Number.isFinite(thb)) {
    if (Number.isFinite(amount) && Number.isFinite(receive)) {
      if (side === 'buy') { thb = thb ?? amount; btc = btc ?? receive; }
      else { btc = btc ?? amount; thb = thb ?? receive; }
    } else if (Number.isFinite(amount)) {
      // เดาจากขนาดตัวเลข: จำนวน BTC ต่อรายการมักน้อยกว่า 5
      if (amount < 5) { btc = amount; thb = amount * price; }
      else { thb = amount; btc = amount / price; }
    }
  }
  if (!Number.isFinite(btc)) btc = Number.isFinite(thb) ? thb / price : NaN;
  if (!Number.isFinite(thb)) thb = Number.isFinite(btc) ? btc * price : NaN;
  if (!Number.isFinite(btc) || !Number.isFinite(thb) || btc <= 0 || thb <= 0) return null;
  if (btc > 100) return null; // กันตีความ THB เป็น BTC ผิด

  // sanity: btc*price ต้องใกล้เคียง thb (คลาดเคลื่อนได้จากค่าธรรมเนียม)
  if (Math.abs(btc * price - thb) / thb > 0.15) return null;

  const ts = parseTs(o);
  if (!Number.isFinite(ts)) return null;

  const fee = num(pick(o, ['fee', 'fee_thb', 'fee_amount']));
  const t = {
    ts,
    date: new Date(ts).toISOString(),
    pair: 'BTC/THB',
    side,
    btc: round(btc, 8),
    price: round(price, 2),
    thb: round(thb, 2),
    fee: Number.isFinite(fee) ? round(fee, 8) : 0,
    source,
  };
  t.id = String(pick(o, ['txn_id', 'transaction_id', 'order_id', 'id', 'hash']) ?? makeId(t));
  return t;
}

function round(n, d) { return Math.round(n * 10 ** d) / 10 ** d; }

// เดินสำรวจ JSON ทั้งก้อน หา array ของ object ที่หน้าตาเหมือนรายการเทรด
export function extractTradesFromJson(root, source = 'scrape') {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const t = parseTradeObject(item, source);
        if (t) out.push(t); else walk(item);
      }
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(root);
  return out;
}

// ---------- CSV (สำหรับไฟล์ export จากหน้า history ของ Bitkub) ----------
function splitCsvLine(line) {
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells.map(s => s.trim());
}

export function parseCsv(text, source = 'csv') {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const col = (patterns) => header.findIndex(h => patterns.some(p => h.includes(p)));
  const iDate = col(['date', 'time', 'วันที่', 'เวลา']);
  const iPair = col(['pair', 'sym', 'coin', 'asset', 'เหรียญ', 'สกุล']);
  const iSide = col(['side', 'type', 'ประเภท', 'ฝั่ง']);
  const iPrice = col(['price', 'rate', 'ราคา']);
  const iAmount = col(['amount (btc)', 'amount(btc)', 'volume', 'จำนวน', 'amount']);
  const iTotal = col(['total', 'value', 'cost', 'มูลค่า', 'รวม']);
  const iFee = col(['fee', 'ค่าธรรมเนียม']);

  const out = [];
  for (let li = 1; li < lines.length; li++) {
    const c = splitCsvLine(lines[li]);
    const get = (i) => (i >= 0 && i < c.length ? c[i] : undefined);
    const t = parseTradeObject({
      date: get(iDate),
      sym: get(iPair),
      side: get(iSide),
      rate: get(iPrice),
      base_amount: get(iAmount),
      quote_amount: get(iTotal),
      fee: get(iFee),
    }, source);
    if (t) out.push(t);
  }
  return out;
}

// ---------- จัดเก็บ + รวมข้อมูล ----------
export function loadTrades() {
  try {
    const j = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    return { trades: j.trades ?? [], meta: j.meta ?? {} };
  } catch {
    return { trades: [], meta: {} };
  }
}

export function saveTrades(trades, meta = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  trades.sort((a, b) => a.ts - b.ts);
  fs.writeFileSync(TRADES_FILE, JSON.stringify({ trades, meta }, null, 2));
}

export function mergeTrades(existing, incoming) {
  const map = new Map(existing.map(t => [t.id, t]));
  // กันกรณี id ต่างกันแต่เป็นรายการเดียวกัน (แหล่งข้อมูลคนละแบบ) ด้วยลายเซ็นเนื้อหา
  const sig = (t) => `${Math.round(t.ts / 60000)}|${t.side}|${t.btc}|${Math.round(t.price)}`;
  const sigs = new Set(existing.map(sig));
  let added = 0;
  for (const t of incoming) {
    if (map.has(t.id) || sigs.has(sig(t))) continue;
    map.set(t.id, t);
    sigs.add(sig(t));
    added++;
  }
  return { trades: [...map.values()].sort((a, b) => a.ts - b.ts), added };
}

// ---------- คำนวณต้นทุนแบบถัวเฉลี่ย ----------
export function computeStats(trades) {
  let qty = 0, cost = 0, realized = 0;
  let buyBtc = 0, buyThb = 0, sellBtc = 0, sellThb = 0;
  for (const t of [...trades].sort((a, b) => a.ts - b.ts)) {
    if (t.side === 'buy') {
      qty += t.btc; cost += t.thb;
      buyBtc += t.btc; buyThb += t.thb;
    } else {
      const avg = qty > 0 ? cost / qty : 0;
      const sold = Math.min(t.btc, qty);
      realized += t.thb - sold * avg;
      cost -= sold * avg;
      qty -= sold;
      sellBtc += t.btc; sellThb += t.thb;
    }
  }
  return {
    holdingBtc: qty,
    holdingCostThb: cost,
    avgCost: qty > 0 ? cost / qty : 0,
    realizedPnl: realized,
    buyBtc, buyThb, sellBtc, sellThb,
    tradeCount: trades.length,
  };
}
