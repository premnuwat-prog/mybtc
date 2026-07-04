// เข้ารหัส data/trades.json -> docs/data.enc ก่อนขึ้น GitHub (repo เป็น public)
// รูปแบบ: PBKDF2-SHA256 210,000 รอบ -> AES-256-GCM (ถอดรหัสในเบราว์เซอร์ด้วย WebCrypto)
// รหัสผ่านอ่านจากไฟล์ .encrypt-pass (ไม่ถูก commit) หรือ env PUBLISH_KEY
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASS_FILE = path.join(ROOT, '.encrypt-pass');
const SRC = path.join(ROOT, 'data', 'trades.json');
const OUT = path.join(ROOT, 'docs', 'data.enc');

const pass = (process.env.PUBLISH_KEY ?? (fs.existsSync(PASS_FILE) ? fs.readFileSync(PASS_FILE, 'utf8') : '')).trim();
if (!pass) {
  console.error('ไม่พบรหัสผ่าน — สร้างไฟล์ .encrypt-pass (บรรทัดเดียว) หรือกำหนด env PUBLISH_KEY');
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error('ยังไม่มี data/trades.json — กดดึงข้อมูลจาก Bitkub ก่อน');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(pass, salt, 210000, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const plain = fs.readFileSync(SRC);
const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]); // WebCrypto ต้องการ tag ต่อท้าย

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  v: 1, kdf: 'PBKDF2-SHA256', iter: 210000,
  salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'),
  updatedAt: new Date().toISOString(),
}));
console.log(`เข้ารหัสแล้ว -> docs/data.enc (${ct.length} bytes)`);
