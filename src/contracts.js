import { z } from 'zod';
export const id = z.string().trim().min(1).max(100);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v); return !isNaN(d) && d.toISOString().slice(0, 10) === v;
}, 'Expected a real calendar date');
export const productsRequest = z.object({ customer: id, requestedDate: date,
  products: z.array(id).min(1).max(1000).refine(v => new Set(v).size === v.length, 'Duplicate products') }).strict();
export const selectedRequest = z.object({ requestedDate: date, products: productsRequest.shape.products,
  selection_ids: z.array(z.string().uuid()).min(1).max(100) }).strict();
export const orderRequest = z.object({ quote_id: z.string().uuid(), force_flag: z.boolean().default(false),
  items: z.array(z.object({ productId: id, quantity: z.number().finite().positive().max(1000000), substitutedFrom: id.optional() }).strict()).min(1).max(1000)
    .refine(v => new Set(v.map(i => i.productId)).size === v.length, 'Duplicate order products') }).strict();
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function assert(condition, status, message) { if (!condition) throw new HttpError(status, message); }
export function round3(value) {
  if (value === null || value === undefined || value === '') return value;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(3)) : value;
}
