import { z } from 'zod';
const lineSchema = z.object({
  id: z.string().min(1), quantity: z.number().positive().finite(), salesUnit: z.string().min(1),
  required: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
  preferred: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({})
});
export class ProcurementSession {
  constructor({ catalog, client, customer, requestedDate, now = () => new Date() }) {
    z.iso.date().parse(requestedDate);
    if (!customer) throw Error('customer required');
    Object.assign(this, { catalog, client, customer, requestedDate, now });
    this.inventory = new Map(); this.lines = new Map(); this.basket = []; this.busy = false;
  }
  async check(products) {
    const missing = products.filter(p => !this.inventory.has(p.id));
    for (let i = 0; i < missing.length; i += 1000) {
      const batch = missing.slice(i, i + 1000);
      const result = await this.client.availability({ customer: this.customer, requestedDate: this.requestedDate, products: batch.map(p => p.id) });
      for (const product of batch) {
        const p = result.products.find(p => p.productId === product.id);
        const s = p?.scheduleLines?.[0];
        // Naive Helsinki timestamps cannot safely be compared with UTC. Fail closed.
        const cutoff = p?.closingTime;
        const validCutoff = !cutoff || (/(Z|[+-]\d\d:\d\d)$/.test(cutoff) && Date.parse(cutoff) >= this.now().getTime());
        const eligible = p && !p.salesBlock && p.scheduleLines.length === 1 && !s.salesBlock && s.salesUnit === product.salesUnit && s.availableDate && /^\d{4}-\d{2}-\d{2}/.test(s.availableDate) && s.availableDate.slice(0,10) <= this.requestedDate && validCutoff;
        const stock = eligible && p.logisticModel === 'Stock' && Number.isFinite(s.availableAmount) && s.availableAmount >= 0 ? s.availableAmount : 0;
        this.inventory.set(product.id, { remaining: stock, cutoff, reason: p?.logisticModel === 'Terminal' ? 'UNKNOWN_TERMINAL_STOCK' : stock ? null : 'UNAVAILABLE' });
      }
    }
  }
  async process(input, { approvedProductIds = [] } = {}) {
    if (this.busy) throw Error('Session already processing');
    this.busy = true;
    try {
      const line = lineSchema.parse(input);
      const previous = this.lines.get(line.id);
      if (previous && JSON.stringify(previous.line) !== JSON.stringify(line)) throw Error('Line ID reused with different requirements');
      if (previous?.status === 'COMPLETE') return this.summary();
      const state = previous || { line, fulfilled: 0, status: 'PENDING', suggestions: [] };
      this.lines.set(line.id, state);
      const hard = { ...line.required, salesUnit: line.salesUnit };
      const primaries = await this.catalog.search({ ...line.preferred, ...hard });
      const broad = await this.catalog.search(hard);
      if (!primaries.length && !approvedProductIds.length) {
        Object.assign(state, { reason: 'NO_MATCH', suggestions: broad.map(p => p.id) });
        return this.summary();
      }
      if (approvedProductIds.some(id => !state.suggestions.includes(id) || !broad.some(p => p.id === id))) throw Error('Approval must select a proposed eligible product');
      const originals = approvedProductIds.length ? broad.filter(p => approvedProductIds.includes(p.id)) : primaries;
      const all = await this.catalog.download();
      const ids = new Set(originals.flatMap(p => (p.substitutions || []).filter(s => s.product === p.id).map(s => s.substituteProduct)));
      const substitutes = all.filter(p => ids.has(p.id) && !originals.some(o => o.id === p.id) && this.catalog.matches(p, hard));
      for (const group of [originals, substitutes]) {
        if (state.fulfilled >= line.quantity) break;
        await this.check(group);
        for (const p of group) {
          const stock = this.inventory.get(p.id);
          if (stock.cutoff && Date.parse(stock.cutoff) < this.now().getTime()) continue;
          const need = line.quantity - state.fulfilled;
          const quantity = Math.floor((Math.min(need, stock.remaining) + 1e-10) / p.allowedLotSize) * p.allowedLotSize;
          if (!(quantity > 0) || quantity > stock.remaining || quantity > need) continue;
          stock.remaining -= quantity;
          state.fulfilled = Number((state.fulfilled + quantity).toPrecision(15));
          this.basket.push({ lineId: line.id, productId: p.id, quantity });
        }
      }
      state.status = Math.abs(state.fulfilled - line.quantity) < 1e-9 ? 'COMPLETE' : 'PENDING';
      state.reason = state.status === 'COMPLETE' ? null : 'SHORTFALL';
      return this.summary();
    } finally { this.busy = false; }
  }
  async run(lines) {
    for (const line of lines) {
      await this.process(line);
      if (this.lines.get(line.id).status !== 'COMPLETE') break;
    }
    return this.summary();
  }
  summary() {
    return {
      completedOrders: this.basket.map(item => ({ ...item, remainingStock: this.inventory.get(item.productId).remaining })),
      pendingIntervention: [...this.lines.values()].filter(s => s.status === 'PENDING').map(s => ({ ...s, shortfall: s.line.quantity - s.fulfilled })),
      inventory: Object.fromEntries(this.inventory),
      simulated: true
    };
  }
}
