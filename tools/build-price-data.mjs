// สร้าง docs/price-data.json สำหรับเว็บออนไลน์
// ไฟล์นี้เก็บราคาล่าสุด BTC/THB จาก Bitkub เพื่อใช้ใน GitHub Pages (static site)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'docs', 'price-data.json');

async function main() {
  const r = await fetch('https://api.bitkub.com/api/market/ticker', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Bitkub ticker HTTP ${r.status}`);
  const j = await r.json();
  const last = Number(j.THB_BTC?.last ?? j.data?.THB_BTC?.last ?? NaN) || null;
  const payload = {
    last,
    at: Date.now(),
    source: 'bitkub'
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`สร้าง docs/price-data.json แล้ว (last=${last ?? 'null'})`);
}

try {
  await main();
} catch (e) {
  console.error(`สร้างข้อมูลราคาล่าสุดไม่สำเร็จ: ${e.message}`);
  process.exit(1);
}
