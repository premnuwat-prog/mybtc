// สคริปต์ดึงประวัติการซื้อขายจาก "หน้าเว็บ" Bitkub (ไม่ใช้ API key)
// วิธีทำงาน: เปิด Chrome จริงบนเครื่อง (โปรไฟล์แยกในโฟลเดอร์ browser-profile)
// -> ไปที่ https://www.bitkub.com/history -> ถ้ายังไม่ล็อกอิน ให้ผู้ใช้ล็อกอินเอง
// -> ดักจับ JSON ที่หน้าเว็บโหลด (network response) + อ่านตารางบนหน้าจอเป็นแผนสำรอง
// -> รวมเข้ากับ data/trades.json (ไม่ซ้ำรายการเดิม)
// ทุกครั้งที่รันจะเก็บหลักฐานไว้ที่ data/raw/ (screenshot, html, รายการ network)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  DATA_DIR, RAW_DIR, extractTradesFromJson, parseTradeObject,
  loadTrades, saveTrades, mergeTrades,
} from './lib/trades.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, 'browser-profile');
const HISTORY_URL = 'https://www.bitkub.com/history';
const LOGIN_WAIT_MS = 6 * 60 * 1000;   // รอให้ล็อกอินได้สูงสุด 6 นาที
const AFTER_LOGIN_WAIT_MS = 45_000;    // หลังล็อกอิน รอข้อมูลอย่างน้อยเท่านี้
const QUIET_MS = 8000;                 // หลังข้อมูลหยุดไหลเข้า 8 วิ ถือว่าจบ

const log = (msg) => console.log(`[sync] ${msg}`);

function saveRaw(name, text) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(path.join(RAW_DIR, name), text);
}

async function launch() {
  const opts = { headless: false, viewport: null, args: ['--disable-blink-features=AutomationControlled'] };
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel });
    } catch { /* ลองตัวถัดไป */ }
  }
  throw new Error('ไม่พบ Google Chrome หรือ Microsoft Edge บนเครื่อง — โปรดติดตั้ง Chrome ก่อน');
}

// เช็คว่ายังไม่ได้ล็อกอินหรือไม่ ดูจาก URL และปุ่ม "เข้าสู่ระบบ" บนหน้าจอ
async function isLoggedOut(page) {
  const url = page.url();
  if (/signin|login|auth|verify|account/i.test(url)) return true;
  const hasPassword = await page.locator('input[type="password"]')
    .first().isVisible({ timeout: 300 }).catch(() => false);
  if (hasPassword) return true;
  for (const sel of [
    'a[href*="signin"]', 'a[href*="login"]',
    'a:has-text("เข้าสู่ระบบ")', 'button:has-text("เข้าสู่ระบบ")',
    'a:has-text("Sign in")', 'button:has-text("Sign in")', 'a:has-text("Log in")',
  ]) {
    if (await page.locator(sel).first().isVisible({ timeout: 200 }).catch(() => false)) return true;
  }
  return false;
}

// อ่านตารางที่แสดงบนหน้าจอ (แผนสำรอง กรณีดัก JSON ไม่ได้)
async function scrapeDomRows(page) {
  const rows = await page.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll('table tr, [role="row"]')) {
      const cells = [...tr.querySelectorAll('td, [role="cell"], [role="gridcell"]')]
        .map(td => td.innerText.trim()).filter(Boolean);
      if (cells.length >= 4) out.push(cells);
    }
    return out;
  }).catch(() => []);

  const trades = [];
  for (const cells of rows) {
    const line = cells.join(' | ');
    if (!/btc/i.test(line)) continue;
    const side = /(sell|ask|ขาย)/i.test(line) ? 'sell' : (/(buy|bid|ซื้อ)/i.test(line) ? 'buy' : null);
    if (!side) continue;
    const dateCell = cells.find(c => /\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/.test(c));
    if (!dateCell) continue;
    const nums = cells.flatMap(c => {
      const m = c.replace(/[,฿]/g, '').match(/-?\d+(?:\.\d+)?/g) ?? [];
      return m.map(Number);
    }).filter(n => n > 0);
    const price = Math.max(...nums, 0);
    const btcCand = nums.filter(n => n < 5 && n !== price);
    if (price < 1000 || !btcCand.length) continue;
    // เลือกจำนวน BTC ที่คูณราคาแล้วใกล้กับตัวเลข "มูลค่ารวม" ในแถวมากที่สุด
    let best = null;
    for (const b of btcCand) {
      const total = nums.find(n => n !== price && n !== b && Math.abs(n - b * price) / (b * price) < 0.1);
      const score = total ? 0 : 1;
      if (!best || score < best.score) best = { b, total: total ?? b * price, score };
    }
    const t = parseTradeObject({
      date: dateCell, side, rate: price,
      base_amount: best.b, quote_amount: best.total, sym: 'BTC/THB',
    }, 'scrape-dom');
    if (t) trades.push(t);
  }
  return trades;
}

async function clickIfVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 })) { await loc.click(); return true; }
    } catch { /* ไม่มีปุ่มนี้ */ }
  }
  return false;
}

// เก็บหลักฐานหน้าจอ/HTML/รายการ network ไว้วิเคราะห์
async function saveEvidence(page, xhrSeen) {
  try {
    await page.screenshot({ path: path.join(RAW_DIR, 'last-page.png'), fullPage: false });
    saveRaw('last-page.html', await page.content());
    saveRaw('network-manifest.json', JSON.stringify({ finalUrl: page.url(), responses: xhrSeen }, null, 2));
    log(`เก็บหลักฐานไว้ที่ data/raw/ (last-page.png, last-page.html, network-manifest.json)`);
  } catch (e) {
    log(`เก็บหลักฐานไม่สำเร็จ: ${e.message}`);
  }
}

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  log('กำลังเปิดเบราว์เซอร์...');
  const context = await launch();
  const page = context.pages()[0] ?? await context.newPage();

  const captured = [];
  const xhrSeen = [];
  let lastCaptureAt = Date.now();
  let rawIndex = 0;

  context.on('response', async (res) => {
    try {
      const url = res.url();
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const text = await res.text().catch(() => '');
      xhrSeen.push({ url, status: res.status(), size: text.length });
      if (!text || text.length > 5_000_000) return;
      let body;
      try { body = JSON.parse(text); } catch { return; }
      const trades = extractTradesFromJson(body);
      if (trades.length) {
        captured.push(...trades);
        lastCaptureAt = Date.now();
        log(`พบรายการเทรด ${trades.length} รายการจาก ${new URL(url).pathname}`);
      }
      // เก็บ JSON ดิบของ endpoint ที่น่าจะเกี่ยวข้องไว้ debug
      if (/(history|order|trade|txn|transaction|fiat|balance)/i.test(url)) {
        saveRaw(`capture-${String(++rawIndex).padStart(3, '0')}.json`,
          JSON.stringify({ url, body }, null, 2));
      }
    } catch { /* response ที่อ่านไม่ได้ ข้ามไป */ }
  });

  log(`กำลังไปที่ ${HISTORY_URL}`);
  await page.goto(HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000); // ให้ SPA โหลดก่อนค่อยตัดสินว่าล็อกอินหรือยัง

  // รอจนล็อกอินเสร็จ (ผู้ใช้ล็อกอินเองในหน้าต่างที่เปิดขึ้น)
  const start = Date.now();
  let warnedLogin = false;
  let loggedIn = false;
  while (Date.now() - start < LOGIN_WAIT_MS) {
    if (page.isClosed()) throw new Error('หน้าต่างเบราว์เซอร์ถูกปิดก่อนดึงข้อมูลเสร็จ');
    if (!(await isLoggedOut(page))) {
      if (/history/i.test(page.url())) { loggedIn = true; break; }
      await page.goto(HISTORY_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
      continue;
    }
    if (!warnedLogin) {
      log('ยังไม่ได้ล็อกอิน — โปรดล็อกอิน Bitkub ในหน้าต่างเบราว์เซอร์ที่เปิดขึ้น (รอสูงสุด 6 นาที)...');
      warnedLogin = true;
    }
    await page.waitForTimeout(2500);
  }
  if (!loggedIn) {
    await saveEvidence(page, xhrSeen);
    await context.close();
    throw new Error('หมดเวลารอล็อกอิน — กดปุ่มดึงข้อมูลใหม่อีกครั้งแล้วล็อกอินให้เสร็จ');
  }

  log('ล็อกอินแล้ว อยู่ที่หน้า History กำลังรอประวัติการซื้อขายโหลด...');
  await page.waitForTimeout(5000);

  // พยายามเลือกแท็บ/ฟิลเตอร์ฝั่งซื้อขาย (ถ้ามี) เพื่อให้หน้าเว็บยิงข้อมูลเทรดออกมา
  await clickIfVisible(page, [
    'button:has-text("Trade")', '[role="tab"]:has-text("Trade")',
    'button:has-text("ซื้อขาย")', '[role="tab"]:has-text("ซื้อขาย")',
    'a[href*="trade"]:has-text("Trade")',
  ]);
  await page.waitForTimeout(3000);

  // ไล่กดหน้าถัดไปเพื่อเก็บประวัติย้อนหลังทั้งหมด (สูงสุด 40 หน้า)
  const domTrades = [];
  for (let i = 0; i < 40; i++) {
    domTrades.push(...await scrapeDomRows(page));
    const moved = await clickIfVisible(page, [
      '.ant-pagination-next:not(.ant-pagination-disabled)',
      'button[aria-label*="next" i]:not([disabled])',
      'li[title="Next Page"]:not(.ant-pagination-disabled)',
      'button:has-text("ถัดไป"):not([disabled])',
      'button:has-text("Next"):not([disabled])',
    ]);
    if (!moved) break;
    await page.waitForTimeout(1800);
  }

  // รอให้ข้อมูลหยุดไหลเข้า (อย่างน้อย AFTER_LOGIN_WAIT_MS ถ้ายังไม่เจออะไรเลย)
  const waitStart = Date.now();
  while (Date.now() - lastCaptureAt < QUIET_MS
    || (!captured.length && !domTrades.length && Date.now() - waitStart < AFTER_LOGIN_WAIT_MS)) {
    await page.waitForTimeout(500);
  }

  await saveEvidence(page, xhrSeen);
  await context.close();

  const incoming = captured.length ? captured : domTrades;
  const how = captured.length ? 'network JSON' : 'อ่านจากตารางบนหน้าจอ';
  const { trades: existing } = loadTrades();
  const { trades, added } = mergeTrades(existing, incoming);
  saveTrades(trades, { lastSync: new Date().toISOString(), lastSyncMethod: how, lastSyncFound: incoming.length });

  log(`เสร็จสิ้น: พบ ${incoming.length} รายการ (${how}), เพิ่มใหม่ ${added}, รวมทั้งหมด ${trades.length}`);
  if (!incoming.length) {
    log('ไม่พบรายการเทรดเลย — ดูหลักฐานใน data/raw/ เพื่อวิเคราะห์');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`[sync] ผิดพลาด: ${e.message}`);
  process.exit(1);
});
