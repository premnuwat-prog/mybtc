import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = [
  ['local app', new URL('../public/index.html', import.meta.url)],
  ['GitHub Pages app', new URL('../docs/index.html', import.meta.url)],
];

for (const [name, url] of pages) {
  test(`${name} has a manual latest-price refresh button with loading feedback`, async () => {
    const html = await readFile(url, 'utf8');

    assert.match(html, /id="refreshPriceBtn"[^>]*onclick="refreshPrice\(\)"/);
    assert.match(html, /async function refreshPrice\(\)/);
    assert.match(html, /refreshPriceBtn[\s\S]*disabled = true/);
    assert.match(html, /กำลัง Refresh/);
  });
}

test('GitHub Pages manual refresh requests a live BTC/THB price instead of only its scheduled static file', async () => {
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');

  assert.match(html, /api\.coingecko\.com\/api\/v3\/simple\/price\?ids=bitcoin&vs_currencies=thb/);
  assert.match(html, /j\.bitcoin\?\.thb/);
});
