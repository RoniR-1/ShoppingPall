import { productsRequest, HttpError } from './contracts.js';

// The supplier snapshot is an offline input, never a network fallback.
export class ValioClient {
  constructor({ inventoryPool, mock = process.env.VALIO_MOCK === 'true' } = {}) { this.inventoryPool = inventoryPool; this.mock = mock; }
  price(request) { return this.call('price', request); }
  availability(request) { return this.call('availability', request); }
  async call(endpoint, input) {
    const request = productsRequest.parse(input);
    const db = this.inventoryPool ?? (await import('./db.js')).pool;
    const rows = (await db.query(`SELECT product_id, price, availability, currency, captured_at, source, requested_date::text AS requested_date
      FROM valio_catalog WHERE product_id=ANY($1::text[])`, [request.products])).rows;
    const byId = new Map(rows.map(row => [row.product_id, row]));
    if (request.products.some(id => !byId.has(id))) throw new HttpError(503, 'Catalog snapshot incomplete; import data/valio-catalog.json');
    const currencies = new Set(rows.map(row => row.currency));
    if (currencies.size !== 1) throw new HttpError(503, 'Catalog snapshot has inconsistent currencies');
    if (endpoint === 'price') return { customerId: request.customer, currency: rows[0].currency,
      pricingDate: request.requestedDate, snapshotDate: rows[0].requested_date, snapshotSource: rows[0].source, products: request.products.map(id => byId.get(id).price) };
    let stockById;
    if (this.mock) {
      const stock = (await db.query('SELECT product_id, quantity FROM inventory WHERE product_id=ANY($1::text[])', [request.products])).rows;
      stockById = new Map(stock.map(row => [row.product_id, Number(row.quantity)]));
    }
    return { timeNow: new Date(Math.max(...rows.map(row => new Date(row.captured_at).getTime()))).toISOString(),
      requestedDate: request.requestedDate, snapshotDate: rows[0].requested_date, snapshotSource: rows[0].source, products: request.products.map(id => {
        const value = byId.get(id).availability;
        if (!this.mock) return value;
        const quantity = stockById.get(id) ?? 0;
        return { ...value, scheduleLines: value.scheduleLines.map(line => ({ ...line, availableAmount: Math.min(line.availableAmount, quantity) })) };
      }) };
  }
}
