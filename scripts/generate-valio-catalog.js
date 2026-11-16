// Deterministic demo estimates, not supplier prices or actual inventory.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { validateSnapshot } from '../src/catalog-snapshot.js';

const baseline = '2020-01-01';
const products = JSON.parse(await readFile(new URL('../product_data.json', import.meta.url), 'utf8'));
const round = value => Math.round(value * 100) / 100;
function hash(text) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}
function unitSize(product) {
  if (['KG', 'KGM', 'L', 'LTR'].includes(product.salesUnit)) return 1;
  const base = product.synkkaData?.unitConversions?.find(item => item.synkkaPackagingType === 'BASE_UNIT_OR_EACH');
  const measure = base?.netWeight ?? base?.volume;
  const units = { GRM: 0.001, KGM: 1, MLT: 0.001, LTR: 1 };
  let size = Number(measure?.value) * (units[measure?.unit] ?? 0);
  if (!(size > 0)) {
    const name = product.synkkaData?.names?.find(item => item.language === 'en')?.value ?? '';
    const match = name.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i);
    if (match) size = Number(match[1].replace(',', '.')) * ({ kg: 1, g: 0.001, l: 1, ml: 0.001 })[match[2].toLowerCase()];
  }
  const multiplier = product.units?.find(unit => unit.unitId === product.salesUnit)?.sizeInBaseUnits ?? 1;
  return Math.min(50, Math.max(0.1, (size || 0.5) * (Number(multiplier) > 0 ? Number(multiplier) : 1)));
}
function unitRate(product) {
  const name = (product.synkkaData?.names ?? []).map(item => item.value).join(' ').toLowerCase();
  if (/fish|salmon|shrimp|lohi|kala|beef|nauta/.test(name)) return 18;
  if (/chicken|pork|cheese|kana|juusto|sika/.test(name)) return 11;
  if (/coffee|chocolate|spice|kahvi|suklaa/.test(name)) return 15;
  if (/milk|yogurt|maito|jogurtti|juice|mehu/.test(name)) return 3;
  if (/pasta|rice|flour|peruna|potato|pasta|riisi/.test(name)) return 3.5;
  return 6;
}
const prices = [], availability = [];
for (const product of products) {
  const value = round(Math.max(0.45, Math.min(300, unitSize(product) * unitRate(product) * (0.85 + (hash(product.id) % 31) / 100))));
  const blocked = Boolean(product.deleted);
  const lot = Number(product.allowedLotSize);
  if (!(lot > 0)) throw Error(`Invalid lot size for ${product.id}`);
  const stock = round(Math.max(1, Math.floor((30 + hash(`stock:${product.id}`) % 471) / lot)) * lot);
  prices.push({ productId: product.id, quantity: 1, netPriceFound: false, error: false,
    priceWithTax: { value, currency: 'EUR', validFrom: baseline, validTo: '9999-12-31' } });
  availability.push({ productId: product.id, salesBlock: blocked, logisticModel: 'Stock', closingTime: null,
    scheduleLines: blocked ? [] : [{ availableAmount: stock, availableDate: baseline, salesUnit: product.salesUnit, salesBlock: false }] });
}
const snapshot = { version: 1, source: 'synthetic', customer: '123', requestedDate: baseline,
  exportedAt: `${baseline}T00:00:00.000Z`, currency: 'EUR', prices, availability };
validateSnapshot(snapshot, products);
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
const target = new URL('../data/valio-catalog.json', import.meta.url);
const temporary = new URL(`../data/.valio-catalog-${process.pid}.tmp`, import.meta.url);
try { await writeFile(temporary, JSON.stringify(snapshot) + '\n', { flag: 'wx' }); await rename(temporary, target); }
finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
console.log(`Generated synthetic prices and availability for ${products.length} products`);
