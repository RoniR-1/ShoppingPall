import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, importSnapshot } from '../src/catalog-snapshot.js';
import { ValioClient } from '../src/valio.js';

test('PostgreSQL snapshot restores and can be imported twice without network', { skip: !process.env.DATABASE_URL }, async () => {
  const { pool } = await import('../src/db.js');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const id = (await db.query('SELECT id FROM products LIMIT 1')).rows[0]?.id;
    assert.ok(id, 'seed products before running this test');
    const price = { productId:id, quantity:1, netPriceFound:false, error:false, priceWithTax:{value:4.25,currency:'EUR',validFrom:'2026-11-16',validTo:'2026-12-31'} };
    const availability = { productId:id, salesBlock:false, logisticModel:'Stock', closingTime:null, scheduleLines:[{salesBlock:false,availableAmount:7,availableDate:'2026-11-16',salesUnit:'ST'}] };
    const snapshot = {version:1,customer:'123',requestedDate:'2026-11-16',exportedAt:'2026-11-16T12:00:00Z',currency:'EUR',prices:[price],availability:[availability]};
    const rows = validateSnapshot(snapshot, [{id}]);
    await importSnapshot(db, rows);
    await importSnapshot(db, rows);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM valio_catalog')).rows[0].n, 1);
    const client = new ValioClient({inventoryPool:db, mock:false});
    const request = {customer:'buyer',requestedDate:'2026-11-17',products:[id]};
    assert.deepEqual((await client.price(request)).products,[price]);
    assert.deepEqual((await client.availability(request)).products,[availability]);
    await db.query('UPDATE inventory SET quantity=1000 WHERE product_id=$1',[id]);
    const mock = new ValioClient({inventoryPool:db, mock:true});
    assert.equal((await mock.price(request)).products[0].priceWithTax.value,4.25);
    assert.equal((await mock.availability(request)).products[0].scheduleLines[0].availableAmount,7);
    await db.query('UPDATE inventory SET quantity=2 WHERE product_id=$1',[id]);
    assert.equal((await mock.availability(request)).products[0].scheduleLines[0].availableAmount,2);
    assert.equal((await mock.price(request)).products[0].priceWithTax.value,4.25);
  } finally { await db.query('ROLLBACK'); db.release(); await pool.end(); }
});
