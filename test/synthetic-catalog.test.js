import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSnapshot } from '../src/catalog-snapshot.js';

test('checked-in synthetic catalog covers products and respects sales units and lot sizes', async () => {
  const [products, snapshot] = await Promise.all([
    readFile(new URL('../product_data.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../data/valio-catalog.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);
  assert.equal(snapshot.source, 'synthetic');
  const rows = validateSnapshot(snapshot, products);
  const byId = new Map(products.map(product => [product.id, product]));
  for (const row of rows) {
    const product = byId.get(row.product_id);
    assert.equal(row.source, 'synthetic');
    assert.ok(row.price.priceWithTax.value > 0);
    if (product.deleted) assert.equal(row.availability.salesBlock, true);
    else {
      const [line] = row.availability.scheduleLines;
      assert.equal(line.salesUnit, product.salesUnit);
      assert.ok(line.availableAmount >= product.allowedLotSize);
      const lots = line.availableAmount / product.allowedLotSize;
      assert.ok(Math.abs(lots - Math.round(lots)) < 1e-7);
    }
  }
});
