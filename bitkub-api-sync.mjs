import 'dotenv/config';
import { fetchOrderHistory } from './lib/bitkub-api.mjs';
import { loadTrades, saveTrades, mergeTrades } from './lib/trades.mjs';

const log = (message) => console.log(`[bitkub-api] ${message}`);

async function main() {
  log('กำลังอ่านประวัติ BTC/THB ผ่าน Bitkub API แบบ read-only...');
  const incoming = await fetchOrderHistory({
    apiKey: process.env.BITKUB_API_KEY,
    apiSecret: process.env.BITKUB_API_SECRET,
  });
  const { trades: existing, meta } = loadTrades();
  const { trades, added } = mergeTrades(existing, incoming);
  saveTrades(trades, {
    ...meta,
    lastSync: new Date().toISOString(),
    lastSyncMethod: 'Bitkub API',
    lastSyncFound: incoming.length,
  });
  log(`เสร็จสิ้น: พบ ${incoming.length} รายการ เพิ่มใหม่ ${added} รวมทั้งหมด ${trades.length}`);
  log('หมายเหตุ: Bitkub API ส่งประวัติย้อนหลังปกติได้ประมาณ 90 วัน; ข้อมูลเก่าที่เคยบันทึกไว้จะไม่ถูกลบ');
}

main().catch((error) => {
  console.error(`[bitkub-api] ผิดพลาด: ${error.message}`);
  process.exitCode = 1;
});
