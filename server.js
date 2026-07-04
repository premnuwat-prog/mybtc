// เว็บเซิร์ฟเวอร์ของแอป My BTC Cost (ใช้ในเครื่องคนเดียว)
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTrades, saveTrades, mergeTrades, computeStats, parseCsv, TRADES_FILE } from './lib/trades.mjs';
import { buildChart } from './lib/chart.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4780;
const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ---------- ข้อมูลพอร์ต ----------
app.get('/api/portfolio', (req, res) => {
  const { trades, meta } = loadTrades();
  res.json({ trades: [...trades].sort((a, b) => b.ts - a.ts), stats: computeStats(trades), meta });
});

// ราคา BTC ล่าสุดจาก Bitkub (ticker สาธารณะ ไม่ต้องล็อกอิน) — proxy กัน CORS
app.get('/api/price', async (req, res) => {
  try {
    const r = await fetch('https://api.bitkub.com/api/market/ticker', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const t = j.THB_BTC ?? j.data?.THB_BTC ?? null;
    res.json({ last: Number(t?.last ?? t?.last_price ?? NaN) || null, at: Date.now() });
  } catch {
    res.json({ last: null, at: Date.now() });
  }
});

// ---------- ข้อมูลกราฟ: ราคารายวัน + EMA + on-chain (LTH/STH/MVRV) ----------
const CHART_CACHE = path.join(ROOT, 'data', 'chart-cache.json');
const CHART_TTL = 6 * 60 * 60 * 1000; // ข้อมูล on-chain อัปเดตวันละครั้ง cache 6 ชม.พอ

let chartBuilding = null; // กันยิงซ้ำพร้อมกัน
app.get('/api/chart', async (req, res) => {
  try {
    let cache = null;
    try { cache = JSON.parse(fs.readFileSync(CHART_CACHE, 'utf8')); } catch { /* ยังไม่มี cache */ }
    if (!cache || Date.now() - cache.builtAt > CHART_TTL || req.query.refresh) {
      chartBuilding ??= buildChart().finally(() => { chartBuilding = null; });
      cache = await chartBuilding;
      fs.mkdirSync(path.dirname(CHART_CACHE), { recursive: true });
      fs.writeFileSync(CHART_CACHE, JSON.stringify(cache));
    }
    res.json(cache);
  } catch (e) {
    res.status(502).json({ error: `สร้างข้อมูลกราฟไม่สำเร็จ: ${e.message}` });
  }
});

// ---------- ปุ่ม Sync: รันสคริปต์ดึงข้อมูลจากหน้าเว็บ Bitkub ----------
const sync = { running: false, startedAt: null, log: [], exitCode: null };
const pushLog = (line) => {
  for (const l of String(line).split('\n')) {
    const s = l.trim();
    if (s) sync.log.push(s);
  }
  if (sync.log.length > 200) sync.log.splice(0, sync.log.length - 200);
};

app.post('/api/sync', (req, res) => {
  if (sync.running) return res.status(409).json({ error: 'กำลังดึงข้อมูลอยู่แล้ว' });
  sync.running = true;
  sync.startedAt = Date.now();
  sync.log = [];
  sync.exitCode = null;
  const child = spawn(process.execPath, [path.join(ROOT, 'scraper.mjs')], { cwd: ROOT });
  child.stdout.on('data', pushLog);
  child.stderr.on('data', pushLog);
  child.on('close', (code) => { sync.running = false; sync.exitCode = code; });
  child.on('error', (e) => { sync.running = false; sync.exitCode = 1; pushLog(`รันสคริปต์ไม่ได้: ${e.message}`); });
  res.json({ started: true });
});

app.get('/api/sync/status', (req, res) => res.json(sync));

// ---------- นำเข้า CSV (ไฟล์ export จากหน้า history ของ Bitkub) เป็นแผนสำรอง ----------
app.post('/api/import', (req, res) => {
  const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
  if (!csv) return res.status(400).json({ error: 'ไม่พบเนื้อหา CSV' });
  const incoming = parseCsv(csv);
  if (!incoming.length) return res.status(422).json({ error: 'อ่านรายการเทรดจาก CSV ไม่ได้ (ตรวจหัวคอลัมน์)' });
  const { trades: existing, meta } = loadTrades();
  const { trades, added } = mergeTrades(existing, incoming);
  saveTrades(trades, { ...meta, lastImport: new Date().toISOString() });
  res.json({ found: incoming.length, added, total: trades.length });
});

// ---------- เผยแพร่ขึ้นเว็บออนไลน์ (เข้ารหัสข้อมูล + push ขึ้น GitHub) ----------
let publishing = false;
app.post('/api/publish', (req, res) => {
  if (publishing) return res.status(409).json({ error: 'กำลังเผยแพร่อยู่แล้ว' });
  publishing = true;
  const child = spawn('bash', ['-c',
    'node tools/encrypt-data.mjs && node tools/build-chart-data.mjs' +
    ' && git add docs && (git diff --cached --quiet || git commit -m "อัปเดตข้อมูล") && git push',
  ], { cwd: ROOT });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    publishing = false;
    if (code === 0) res.json({ ok: true, log: out.trim() });
    else res.status(500).json({ error: out.trim() || `exit ${code}` });
  });
  child.on('error', (e) => { publishing = false; res.status(500).json({ error: e.message }); });
});

// ล้างข้อมูลทั้งหมด (เผื่ออยากเริ่มใหม่)
app.delete('/api/trades', (req, res) => {
  fs.rmSync(TRADES_FILE, { force: true });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`My BTC Cost พร้อมใช้งานที่ http://localhost:${PORT}`));
