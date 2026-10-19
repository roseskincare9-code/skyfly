// Builds the Skyfly-hosted copy of the live Larose page (GitHub Pages repo `Larosenigeria`) for
// the Larose business. Only what hosting needs changes; design, copy, images, prices, form and
// pixel stay exactly as on the live page:
//   - form key `larose-skincare` (its own Skyfly landing page; the live page keeps `larosenigeria`)
//   - the page's own Skyfly SDK tag is dropped (Skyfly adds the SDK and pixel config to hosted pages)
//   node scripts/import-larose-page.mjs ../larosenigeria/index.html
import { readFileSync, writeFileSync } from 'node:fs';

const [src = '../larosenigeria/index.html'] = process.argv.slice(2);
let html = readFileSync(src, 'utf8');
const swap = (from, to) => {
  if (html.split(from).length !== 2) throw new Error(`expected exactly one ${JSON.stringify(from.slice(0, 80))}`);
  html = html.replace(from, to);
};
swap('const SKYFLY_PAGE="larosenigeria";', 'const SKYFLY_PAGE="larose-skincare";');
swap('<script src="https://skyfly-gybf.onrender.com/sdk/skyfly.js" data-page="larosenigeria" async></script>\n', '');
for (const must of ['const SKYFLY_API="https://skyfly-gybf.onrender.com"', "fbq('init','1357015185691765')", 'id="skyWa"', 'id="skyUp"', 'skyCanStore']) {
  if (!html.includes(must)) throw new Error(`missing ${must}`);
}
writeFileSync(new URL('../src/import/larose-skincare.html', import.meta.url), html);
console.log(`src/import/larose-skincare.html: ${Math.round(html.length / 1024)} KB`);
