import { parse } from 'csv-parse/sync';
export class Catalog {
  constructor(client) { this.client = client; this.cache = new Map(); }
  async download(kind = 'products') {
    if (!['products','delivery-reliability','carbon-footprint'].includes(kind)) throw Error('Unknown dataset');
    if (!this.cache.has(kind)) this.cache.set(kind, this.client.request('/api/' + kind + '/download', 'GET').then(text => {
      const rows = kind === 'products' ? JSON.parse(text) : parse(text, { columns: true, bom: true, skip_empty_lines: true });
      if (!Array.isArray(rows)) throw Error('Invalid dataset');
      if (kind === 'products' && (rows.some(p => typeof p.id !== 'string' || typeof p.salesUnit !== 'string' || !(p.allowedLotSize > 0)) || new Set(rows.map(p => p.id)).size !== rows.length)) throw Error('Invalid products');
      return rows;
    }).catch(error => { this.cache.delete(kind); throw error; }));
    return this.cache.get(kind);
  }
  matches(product, constraints = {}) {
    return !product.deleted && Object.entries(constraints).every(([path, expected]) => {
      const actual = path.split('.').reduce((v,k) => v?.[k], product);
      return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
    });
  }
  async search(constraints) { return (await this.download()).filter(p => this.matches(p, constraints)); }
}
