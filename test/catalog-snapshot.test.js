import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, importSnapshot } from '../src/catalog-snapshot.js';
import { ValioClient } from '../src/valio.js';
const product = { id: '1' };
const price = { productId: '1', quantity: 1, netPriceFound: false, error: true };
const availability = { productId: '1', salesBlock: true, scheduleLines: [] };
const snapshot = { version: 1, customer: '123', requestedDate: '2026-11-16', exportedAt: '2026-11-16T12:00:00Z', currency: 'EUR', prices: [price], availability: [availability] };
test('snapshot import validates complete coverage before writing and can be repeated', async () => {
  const rows = validateSnapshot(snapshot, [product]);
  for (const bad of [{...snapshot, availability: []}, {...snapshot, prices: [price, price]}, {...snapshot, requestedDate: 'bad'}]) assert.throws(() => validateSnapshot(bad, [product]));
  let saved = [];
  const db = { query: async (sql, args) => { if (sql.startsWith('DELETE')) saved = []; else saved.push(...JSON.parse(args[0])); } };
  await importSnapshot(db, rows); await importSnapshot(db, rows);
  assert.equal(saved.length, 1); assert.deepEqual(saved[0].availability, availability);
});
test('runtime reads only DB and rejects missing products', async () => {
  let result = { rows: [{ ...validateSnapshot(snapshot, [product])[0] }] };
  const client = new ValioClient({ mock: false, inventoryPool: { query: async () => result }, fetchImpl: () => { throw Error('network used'); } });
  const request = { customer: 'buyer', requestedDate: snapshot.requestedDate, products: ['1'] };
  assert.deepEqual((await client.price(request)).products, [price]);
  assert.deepEqual((await client.availability(request)).products, [availability]);
  assert.equal((await client.price({...request, requestedDate:'2026-11-17'})).snapshotDate, snapshot.requestedDate);
  result = { rows: [] };
  await assert.rejects(client.price(request), /snapshot incomplete/);
});
test('simulated checkout caps captured availability using local stock', async () => {
  const recorded = {...availability, salesBlock:false, scheduleLines:[{salesBlock:false, availableAmount:12, availableDate:'2026-11-16', salesUnit:'ST'}]};
  const row = {...validateSnapshot({...snapshot,availability:[recorded]},[product])[0]};
  const client = new ValioClient({mock:true, inventoryPool:{query:async sql => sql.includes('FROM inventory') ? {rows:[{product_id:'1',quantity:3}]} : {rows:[row]}}});
  const request = {customer:'buyer',requestedDate:snapshot.requestedDate,products:['1']};
  assert.equal((await client.availability(request)).products[0].scheduleLines[0].availableAmount,3);
  assert.equal(recorded.scheduleLines[0].availableAmount,12);
});
