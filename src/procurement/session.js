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
        const validCutoff = !cutoff || (/(Z|[+-]\d\d:\d\d)$/.test(cutoff) && Date.parse(cutoff) > this.now().getTime());
        const eligible = p && !p.salesBlock && p.scheduleLines.length === 1 && !s.salesBlock && s.salesUnit === product.salesUnit && typeof s.availableDate === 'string' && z.iso.date().safeParse(s.availableDate.slice(0,10)).success && s.availableDate.slice(0,10) <= this.requestedDate && validCutoff;
        const stock = eligible && p.logisticModel === 'Stock' && Number.isFinite(s.availableAmount) && s.availableAmount >= 0 ? s.availableAmount : 0;
        this.inventory.set(product.id, { remaining: stock, cutoff, reason: p?.logisticModel === 'Terminal' ? 'UNKNOWN_TERMINAL_STOCK' : stock ? null : 'UNAVAILABLE' });
      }
    }
  }
  async process(input, { approvedProductIds = [] } = {}) {
    if (this.busy) throw Error('Session already processing');
    this.busy = true;
    // Do not leave partial allocations or cached stock after a failed supplier call.
    const snapshot = { inventory: structuredClone(this.inventory), lines: structuredClone(this.lines), basket: structuredClone(this.basket) };
    try {
      const line = lineSchema.parse(input);
      const previous = this.lines.get(line.id);
      if (previous && JSON.stringify(previous.line) !== JSON.stringify(line)) throw Error('Line ID reused with different requirements');
      if (previous && previous.status !== 'PENDING') return this.summary();
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
      const originals = primaries;
      const all = await this.catalog.download();
      const ids = new Set(originals.flatMap(p => (p.substitutions || []).filter(s => s.product === p.id).map(s => s.substituteProduct)));
      const substitutes = all.filter(p => ids.has(p.id) && !originals.some(o => o.id === p.id) && this.catalog.matches(p, hard));
      const approved = broad.filter(p => approvedProductIds.includes(p.id));
      // Substitutes are proposals only until a person explicitly selects them.
      for (const group of [originals, approved]) {
        if (state.fulfilled >= line.quantity) break;
        await this.check(group);
        for (const p of group) {
          const stock = this.inventory.get(p.id);
          if (stock.cutoff && Date.parse(stock.cutoff) <= this.now().getTime()) continue;
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
      state.suggestions = state.status === 'COMPLETE' ? [] : !primaries.length ? broad.map(p => p.id) : substitutes.map(p => p.id);
      return this.summary();
    } catch (error) {
      this.inventory = snapshot.inventory; this.lines = snapshot.lines; this.basket = snapshot.basket;
      throw error;
    } finally { this.busy = false; }
  }
  // A decision only resolves this local simulation; it never purchases from a supplier.
  resolveShortfall(lineId, decision) {
    if (this.busy) throw Error('Session already processing');
    const state = this.lines.get(lineId);
    if (!state || state.status !== 'PENDING') throw Error('No pending line to resolve');
    if (!['accept', 'reject'].includes(decision)) throw Error('Decision must be accept or reject');
    if (decision === 'accept' && !(state.fulfilled > 0)) throw Error('Cannot accept a shortfall with no allocated stock');
    if (decision === 'reject') {
      for (const item of this.basket.filter(item => item.lineId === lineId)) this.inventory.get(item.productId).remaining += item.quantity;
      this.basket = this.basket.filter(item => item.lineId !== lineId);
      state.fulfilled = 0;
    }
    state.status = decision === 'accept' ? 'SHORTFALL_ACCEPTED' : 'REJECTED';
    state.reason = null; state.suggestions = [];
    return this.summary();
  }
  async run(lines) {
    for (const line of lines) {
      await this.process(line);
      if (this.lines.get(line.id).status === 'PENDING') break;
    }
    return this.summary();
  }
  summary() {
    return {
      completedOrders: this.basket.map(item => ({ ...item, remainingStock: this.inventory.get(item.productId).remaining })),
      pendingIntervention: [...this.lines.values()].filter(s => s.status === 'PENDING').map(s => ({ ...s, shortfall: s.line.quantity - s.fulfilled })),
      resolutions: [...this.lines.values()].filter(s => ['SHORTFALL_ACCEPTED', 'REJECTED'].includes(s.status)).map(s => ({ lineId: s.line.id, status: s.status, fulfilled: s.fulfilled, shortfall: s.line.quantity - s.fulfilled })),
      inventory: Object.fromEntries(this.inventory),
      simulated: true
    };
  }
}
