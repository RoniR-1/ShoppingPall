import { createHash, randomUUID } from 'node:crypto';

// Stable JSON is used both at creation and verification. Values must be JSON data.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v ?? null)).join(',')}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
export function createAuditEvent(input, previousHash = null) {
  const event = JSON.parse(JSON.stringify({ audit_id: input.audit_id || randomUUID(), timestamp: input.timestamp || new Date().toISOString(),
    trace_id: input.trace_id ?? null, order_id: input.order_id ?? null, quote_id: input.quote_id ?? null,
    actor: input.actor, event_type: input.event_type, policy_snapshot: input.policy_snapshot ?? null,
    commercial_commitment: input.commercial_commitment ?? null, previous_hash: previousHash }));
  event.integrity_hash = createHash('sha256').update(canonicalJson(event)).digest('hex');
  return event;
}
export function verifyAuditChain(events) {
  let previous = null;
  for (const event of events) {
    const { integrity_hash, ...payload } = event;
    if (payload.previous_hash !== previous || createHash('sha256').update(canonicalJson(payload)).digest('hex') !== integrity_hash)
      return { valid: false, failed_audit_id: event.audit_id };
    previous = integrity_hash;
  }
  return { valid: true, head_hash: previous, count: events.length };
}
export function projectAuditEvent(event, perspective = 'buyer') {
  if (perspective !== 'wholesaler') return structuredClone(event);
  // Removing the private policy means the projected payload cannot independently verify its hash.
  const { policy_snapshot, ...visible } = structuredClone(event);
  return { ...visible, policy_snapshot: null, policy_redacted: policy_snapshot != null };
}
export function auditCsv(events) {
  const fields = ['audit_id','timestamp','trace_id','order_id','quote_id','actor','event_type','policy_snapshot','commercial_commitment','previous_hash','integrity_hash'];
  const cell = value => `"${String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value).replaceAll('"','""')}"`;
  return [fields.join(','), ...events.map(event => fields.map(field => cell(event[field])).join(','))].join('\r\n');
}
// Must be called in the same transaction as the governed state change.
export async function appendAudit(db, input) {
  if (!input.user_id) throw new Error('Audit user_id required');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 42037))', [input.user_id]);
  const previous = (await db.query('SELECT event FROM audit_events WHERE user_id=$1 ORDER BY sequence DESC LIMIT 1', [input.user_id])).rows[0]?.event;
  const event = createAuditEvent(input, previous?.integrity_hash ?? null);
  await db.query('INSERT INTO audit_events(user_id,event) VALUES($1,$2::jsonb)', [input.user_id, JSON.stringify(event)]);
  return event;
}
export function commercialSnapshot(items, currency, totalCents, requestedDate) {
  return { currency, total_eur: currency === 'EUR' ? Number(totalCents) / 100 : null, total: Number(totalCents) / 100,
    requested_delivery_date: requestedDate ?? null,
    items: items.map(i => ({ sku: i.productId, quantity: i.quantity ?? null, unit_price: i.unit_price ?? null,
      line_total: i.line_total_cents == null ? null : Number(i.line_total_cents) / 100,
      available_amount: i.availableAmount ?? null, delivery_window: i.availability?.scheduleLines ?? i.availableDate ?? null,
      closing_time: i.availability?.closingTime ?? null, price_claim: i.price ?? null, availability_claim: i.availability ?? null })) };
}
export const auditActor = (type, user) => type === 'wholesaler_system'
  ? { type, id: 'valio-aimo-api', role: 'supplier', organization: 'Valio Aimo' }
  : { type, id: type === 'human_approver' ? user : 'purchasing-agent', role: type === 'human_approver' ? 'buyer approver' : 'buyer purchasing agent', organization: user };
