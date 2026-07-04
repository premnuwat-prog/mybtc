// สร้าง docs/chart-data.json (ราคา 4 ปี + EMA + on-chain แปลง THB) สำหรับเว็บออนไลน์
// รันจากเครื่อง local ตอนเผยแพร่ และจาก GitHub Action วันละครั้ง
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChart } from '../lib/chart.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'docs', 'chart-data.json');

try {
  const chart = await buildChart();
  if (!chart.onchainOk) {
    // ถ้าโดน rate limit ของ bitcoin-data.com ให้คงเส้น on-chain จากไฟล์เดิมไว้
    try {
      const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      const oldByDay = new Map(old.days.map(d => [d.d, d]));
      for (const d of chart.days) {
        const o = oldByDay.get(d.d);
        if (o) { d.mvrv = o.mvrv; d.sth = o.sth; d.lth = o.lth; }
      }
      chart.onchainOk = old.onchainOk;
      console.log('ใช้ข้อมูล on-chain จากไฟล์เดิม (แหล่งข้อมูลไม่ตอบ)');
    } catch { /* ไม่มีไฟล์เดิม */ }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(chart));
  console.log(`สร้าง docs/chart-data.json แล้ว (${chart.days.length} วัน, on-chain ${chart.onchainOk ? 'ครบ' : 'ไม่มี'})`);
} catch (e) {
  console.error(`สร้างข้อมูลกราฟไม่สำเร็จ: ${e.message}`);
  process.exit(1);
}
