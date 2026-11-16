import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { ValioExportClient } from '../src/valio-export-client.js';

const products = JSON.parse(await readFile(new URL('../product_data.json', import.meta.url), 'utf8'));
const ids = products.map(p => p.id);
if (!ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw Error('Invalid product catalog');
const customer = process.env.VALIO_CATALOG_CUSTOMER || '123';
const requestedDate = process.env.VALIO_CATALOG_DATE || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
const client = new ValioExportClient();
const prices = [], availability = [];
let currency;
for (let i = 0; i < ids.length; i += 1000) {
  const request = { customer, requestedDate, products: ids.slice(i, i + 1000) };
  const p = await client.price(request);
  const a = await client.availability(request);
  if (currency && currency !== p.currency) throw Error('Inconsistent currency');
  currency = p.currency;
  prices.push(...p.products); availability.push(...a.products);
  console.error(`Exported ${Math.min(i + 1000, ids.length)}/${ids.length}`);
}
const snapshot = { version: 1, customer, requestedDate, exportedAt: new Date().toISOString(), currency, prices, availability };
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
const target = new URL('../data/valio-catalog.json', import.meta.url);
const temp = new URL(`../data/.valio-catalog-${process.pid}.tmp`, import.meta.url);
try { await writeFile(temp, JSON.stringify(snapshot) + '\n', { flag: 'wx' }); await rename(temp, target); }
finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
console.log(`Saved ${ids.length} products to data/valio-catalog.json`);
