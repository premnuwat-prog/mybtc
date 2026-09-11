import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const roots = ['public', 'docs'];

function pngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

for (const root of roots) {
  test(`${root} publishes My BTC Cost install icons and manifest`, async () => {
    const html = await readFile(new URL(`../${root}/index.html`, import.meta.url), 'utf8');
    assert.match(html, /rel="icon" type="image\/png" href="icon-192\.png"/);
    assert.match(html, /rel="apple-touch-icon" href="apple-touch-icon\.png"/);
    assert.match(html, /rel="manifest" href="site\.webmanifest"/);

    for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
      const image = await readFile(new URL(`../${root}/${name}`, import.meta.url));
      assert.deepEqual(pngSize(image), { width: size, height: size });
    }

    const manifest = JSON.parse(await readFile(new URL(`../${root}/site.webmanifest`, import.meta.url), 'utf8'));
    assert.equal(manifest.name, 'My BTC Cost');
    assert.deepEqual(manifest.icons.map((icon) => icon.src), ['icon-192.png', 'icon-512.png']);
  });
}
