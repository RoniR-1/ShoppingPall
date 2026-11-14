import { randomUUID, createHash } from 'node:crypto';
import { transaction } from './db.js';
import { assert } from './contracts.js';
import { OrderScreeningService, OrderStatus } from './order-screening.js';
const defaultScreening = new OrderScreeningService();
export function buildOrderItems(requestItems, quote) {
  return requestItems.map(item => {
    const p = quote.items.find(p => p.productId === item.productId);
    assert(p, 422, `Product ${item.productId} is not in quote`);
    const steps = item.quantity / Number(p.allowed_lot_size);
    assert(Math.abs(steps - Math.round(steps)) < 1e-7, 422, `Quantity must be a multiple of ${p.allowed_lot_size} for ${item.productId}`);
    assert(p.orderable && p.availableAmount >= item.quantity, 422, `Product ${item.productId} is unavailable for requested quantity/date`);
    const line_total_cents = Math.round(p.unit_price * item.quantity * 100);
    assert(Number.isSafeInteger(line_total_cents), 422, 'Order total too large');
    return { ...p, quantity: item.quantity, line_total_cents };
  });
}
export async function createOrder(user, key, input, screening = defaultScreening) {
  const request = { ...input, items: [...input.items].sort((a, b) => a.productId.localeCompare(b.productId)) };
  const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return transaction(async db => {
    // Serialize retries for the same customer/key, including simultaneous first submissions.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([user, key])]);
    const existing = (await db.query('SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2', [user, key])).rows[0];
    if (existing) { assert(existing.request_hash === hash, 409, 'Idempotency key already used for a different order'); return existing; }
    const quote = (await db.query('SELECT * FROM quotes WHERE id=$1 AND user_id=$2 AND expires_at>now()', [input.quote_id, user])).rows[0];
    assert(quote, 409, 'Quote missing, expired, or belongs to another user');
    const items = buildOrderItems(request.items, quote);
    const total = items.reduce((sum, i) => sum + i.line_total_cents, 0);
    assert(Number.isSafeInteger(total), 422, 'Order total too large');
    const screeningResult = screening.evaluate({ userId: user, quoteId: input.quote_id, items, totalCents: total, currency: quote.currency, requestedDate: quote.requested_date });
    const reason = screeningResult.status === OrderStatus.PENDING_REVIEW ? `Suspicion score ${screeningResult.score} exceeds threshold ${screeningResult.threshold}` : input.force_flag ? 'Demo: force_flag requested' :
      items.length > 20 || items.reduce((n, i) => n + i.quantity, 0) > 20 ? 'Demo: more than 20 lines or total sales units' : null;
    const status = reason ? 'PENDING_APPROVAL' : 'APPROVED';
    const result = (await db.query(`INSERT INTO orders (id,user_id,quote_id,idempotency_key,request_hash,status,flag_reason,items,currency,total_cents,mocked,requested_date,decided_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $6='APPROVED' THEN now() ELSE NULL END) RETURNING *`,
      [randomUUID(),user,input.quote_id,key,hash,status,reason,JSON.stringify(items),quote.currency,total,quote.mocked,quote.requested_date])).rows[0];
    await db.query('INSERT INTO order_events(order_id,user_id,status) VALUES ($1,$2,$3)', [result.id,user,status]);
    return result;
  });
}
export async function decideOrder(user, orderId, decision) {
  return transaction(async db => {
    const order = (await db.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE', [orderId,user])).rows[0];
    assert(order, 404, 'Order not found');
    if (order.status === decision) return order;
    assert(order.status === 'PENDING_APPROVAL', 409, 'Order has already been decided');
    if (decision === 'APPROVED') {
      const fresh = (await db.query('SELECT 1 FROM quotes WHERE id=$1 AND expires_at>now()', [order.quote_id])).rowCount;
      assert(fresh, 409, 'Quote expired; reject this order and submit a new quote for review');
    }
    const updated = (await db.query('UPDATE orders SET status=$1,decided_at=now() WHERE id=$2 RETURNING *', [decision,orderId])).rows[0];
    await db.query('INSERT INTO order_events(order_id,user_id,status) VALUES ($1,$2,$3)', [orderId,user,decision]);
    return updated;
  });
}
