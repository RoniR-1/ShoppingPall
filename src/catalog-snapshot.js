import { validateValioResponse } from './procurement/client.js';
import { z } from 'zod';

export function validateSnapshot(snapshot, products) {
  if (snapshot?.version !== 1 || typeof snapshot.customer !== 'string' || !snapshot.customer ||
      !z.iso.date().safeParse(snapshot.requestedDate).success || !Number.isFinite(Date.parse(snapshot.exportedAt)) ||
      typeof snapshot.currency !== 'string' || !snapshot.currency ||
      !['supplier', 'synthetic'].includes(snapshot.source ?? 'supplier')) throw Error('Invalid catalog snapshot metadata');
  const prices = validateValioResponse('price', { customerId: snapshot.customer, pricingDate: snapshot.requestedDate, currency: snapshot.currency, products: snapshot.prices }).products;
  const availability = validateValioResponse('availability', { timeNow: snapshot.exportedAt, requestedDate: snapshot.requestedDate, products: snapshot.availability }).products;
  const ids = new Set(products.map(p => p.id));
  for (const data of [prices, availability]) {
    if (data.length !== ids.size || new Set(data.map(p => p.productId)).size !== ids.size || data.some(p => !ids.has(p.productId))) throw Error('Catalog snapshot does not cover product catalog');
  }
  const stocks = new Map(availability.map(p => [p.productId, p]));
  return prices.map(price => ({ product_id: price.productId, price, availability: stocks.get(price.productId), currency: snapshot.currency,
    customer_id: snapshot.customer, requested_date: snapshot.requestedDate, captured_at: snapshot.exportedAt,
    source: snapshot.source ?? 'supplier' }));
}
export async function importSnapshot(db, rows) {
  await db.query('DELETE FROM valio_catalog');
  for (let i = 0; i < rows.length; i += 200) {
    await db.query('INSERT INTO valio_catalog SELECT * FROM jsonb_populate_recordset(NULL::valio_catalog, $1::jsonb)', [JSON.stringify(rows.slice(i, i + 200))]);
  }
}
