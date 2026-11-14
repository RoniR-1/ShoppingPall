import { randomUUID, createHash } from 'node:crypto';
import { transaction } from './db.js';
import { assert, round3 } from './contracts.js';
import { OrderScreeningService, OrderStatus } from './order-screening.js';
const defaultScreening = new OrderScreeningService();
export function buildOrderItems(requestItems, quote) {
  return requestItems.map(item => {
    const p = quote.items.find(p => p.productId === item.productId);
    assert(p, 422, `Product ${item.productId} is not in quote`);
    const steps = item.quantity / Number(p.allowed_lot_size);
    assert(Math.abs(steps - Math.round(steps)) < 1e-7, 422, `Quantity must be a multiple of ${p.allowed_lot_size} for ${item.productId}`);
    assert(item.quantity > 0, 422, `Quantity must be positive for ${item.productId}`);
    assert(p.orderable && p.availableAmount >= item.quantity, 422, `Product ${item.productId} is unavailable for requested quantity/date`);
    assert(p.price?.error !== true && Array.isArray(p.availability?.scheduleLines) && p.availability.scheduleLines.length > 0 && p.availability.salesBlock !== true, 422, `Product ${item.productId} is blocked`);
    assert(p.logistic_model !== 'Stock' || item.quantity <= p.availableAmount, 422, `Insufficient stock for ${item.productId}`);
    const line_total_cents = Math.round(p.unit_price * item.quantity * 100);
    assert(Number.isSafeInteger(line_total_cents), 422, 'Order total too large');
    let substitution = {};
    if (item.substitutedFrom) {
      const original = quote.items.find(candidate => candidate.productId === item.substitutedFrom);
      assert(original, 422, `Original product ${item.substitutedFrom} must be present in the quote to validate substitution`);
      const mapped = (original.raw?.substitutions || []).some(rule =>
        rule.product === item.substitutedFrom && rule.substituteProduct === item.productId);
      const originalRaw = original.raw?.synkkaData || {};
      const substituteRaw = p.raw?.synkkaData || {};
      const changed = (a,b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
      const ingredientShift = changed(originalRaw.ingredients, substituteRaw.ingredients) ||
        changed(originalRaw.keyIngredients, substituteRaw.keyIngredients);
      const packShift = original.sales_unit !== p.sales_unit || Number(original.allowed_lot_size) !== Number(p.allowed_lot_size) ||
        changed(originalRaw.unitConversions, substituteRaw.unitConversions);
      const nutritionShift = changed(originalRaw.nutritionalContent, substituteRaw.nutritionalContent);
      const substitutionRisk = !mapped ? 'unmapped' : ingredientShift ? 'ingredient_shift' :
        packShift || nutritionShift ? 'mapped_pack_or_nutrition_shift' : null;
      substitution = { substitutionRisk, orig_product_id: original.productId, orig_name: original.name,
        orig_available: Boolean(original.orderable && original.availableAmount >= item.quantity),
        sub_name: p.name, substitution_mapped: mapped };
    }
    return { ...p, ...substitution, quantity: item.quantity, line_total_cents };
  });
}

// Pure scoring function. History/policy are loaded at checkout so scores use committed orders only.
export function scoreOrder(items, { policy, history, now = new Date(), evaluateElements = true }) {
  const cartTotal = round3(items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0));
  const last10 = history.filter(o => o.routine === true && o.exclude_from_baseline !== true).slice(0, 10);
  const W10 = last10.map(o => Number(o.total_cents) / 100);
  const hardLimit = Number(policy.hard_spend_limit);
  const weeklyLimit = Number(policy.weekly_spend_limit);
  const baseline = W10.length ? Math.max(...W10) : 0.25 * hardLimit;
  const spendCap = round3(Math.min(hardLimit, 1.15 * baseline));
  const penalties = { budgetOverrun: 0, quantitySpike: 0, quantityDrop: 0, allergenConflict: 0, weeklySpend: 0, substitution: 0, deliveryDelay: 0, newCategory: 0 };
  const discounts = { recurringStaple: 0, approvedPrecedent: 0 };
  const excludedAllergens = new Set(policy.excluded_allergens || []);
  if (cartTotal > spendCap) penalties.budgetOverrun = round3(30 + 200 * ((cartTotal - spendCap) / spendCap));
  if (history.filter(o => (now - new Date(o.created_at)) <= 7 * 86400000).reduce((s,o) => s + Number(o.total_cents)/100, 0) + cartTotal > weeklyLimit) penalties.weeklySpend = 45;
  const priorCategories = new Set(history.flatMap(o => (o.items || []).map(i => i.category)));
  for (const item of items) {
    if ((item.allergens || []).some(a => excludedAllergens.has(a))) penalties.allergenConflict = 60;
    const prior = last10.flatMap(o => (o.items || []).filter(i => i.productId === item.productId));
    if (prior.length) {
      const maxPrior = Math.max(...prior.map(i => Number(i.quantity)));
      const minPrior = Math.min(...prior.map(i => Number(i.quantity)));
      if (item.quantity > 1.2 * maxPrior) penalties.quantitySpike = round3(Math.max(penalties.quantitySpike, 25 + 40 * (item.quantity / maxPrior - 1.2)));
      if (item.quantity < 0.5 * minPrior) penalties.quantityDrop = round3(Math.max(penalties.quantityDrop, 25 + 20 * (minPrior / Math.max(item.quantity, 0.001) - 2)));
      const count = last10.filter(o => (o.items || []).some(i => i.productId === item.productId)).length;
      if (count >= 5 && item.quantity <= 1.2 * maxPrior && item.quantity >= 0.5 * minPrior) discounts.recurringStaple = Math.max(discounts.recurringStaple, 20);
    }
    if (!priorCategories.has(item.category)) penalties.newCategory = Math.max(penalties.newCategory, 10);
    const substitutionPoints = item.substitutionRisk === 'unmapped' || item.substitutionRisk === 'ingredient_shift' ? 45 :
      item.substitutionRisk === 'mapped_pack_or_nutrition_shift' ? 30 : 0;
    penalties.substitution = Math.max(penalties.substitution, substitutionPoints);
    if (item.approvedPrecedent === true) discounts.approvedPrecedent = Math.max(discounts.approvedPrecedent, 20);
    const availDay = String(item.availableDate || '').slice(0, 10);
    const reqDay = String(item.requestedDate || '').slice(0, 10);
    const dateDiff = availDay && reqDay ? Math.round((Date.parse(availDay) - Date.parse(reqDay)) / 86400000) : 0;
    if (!item.acceptedDeliveryDelay && dateDiff >= 2) penalties.deliveryDelay = Math.max(penalties.deliveryDelay, 65);
    else if (!item.acceptedDeliveryDelay && dateDiff >= 1) penalties.deliveryDelay = Math.max(penalties.deliveryDelay, 35);
  }
  const score = round3(Math.max(0, Object.values(penalties).reduce((a,b)=>a+b,0) - Object.values(discounts).reduce((a,b)=>a+b,0)));
  const questions = buildMandateQuestions(items, { penalties, cartTotal, spendCap, weeklyLimit, history, last10, policy });
  const elementScores = evaluateElements ? items.map(item => {
    const element = scoreOrder([item], { policy, history, now, evaluateElements: false });
    return { product_id: item.productId, score: element.score, decision: element.decision };
  }) : [];
  const elementFails = elementScores.some(element => element.score >= 30);
  return { score, cart_total: cartTotal, max_spend_cap: spendCap, penalties, discounts, questions, element_scores: elementScores,
    decision: score < 30 && !elementFails ? 'AUTO_APPROVE' : 'REQUIRES_INTERVENTION' };
}

function buildMandateQuestions(items, { penalties, cartTotal, spendCap, weeklyLimit, history, last10, policy }) {
  const excludedAllergens = new Set(policy.excluded_allergens || []);
  const questions = [];
  const add = (rule, productId, points, message, alternatives) => questions.push({
    id: `${rule}:${productId || 'cart'}`, rule, product_id: productId || null, points: round3(points), message, alternatives, answer: null
  });
  if (penalties.substitution) for (const item of items.filter(i => i.substitutionRisk)) {
    const substitution = item.sub_name || 'the substitute';
    const original = item.orig_name || item.name || item.productId;
    add('substitution', item.productId, item.substitutionRisk === 'mapped_pack_or_nutrition_shift' ? 30 : 45,
      `Are you alright with ${substitution} instead of ${original}?`, item.orig_product_id && item.orig_available ? ['keep_original', 'cancel'] : ['cancel']);
  }
  if (penalties.allergenConflict) for (const item of items) for (const allergen of (item.allergens || []).filter(a => excludedAllergens.has(a))) {
    add('allergenConflict', item.productId, 60, `${item.name || item.productId} contains ${allergen}. Keep this item in the order?`, ['remove_item', 'cancel']);
  }
  for (const item of items) {
    const availDay = String(item.availableDate || '').slice(0, 10);
    const reqDay = String(item.requestedDate || '').slice(0, 10);
    const delay = availDay && reqDay ? Math.round((Date.parse(availDay) - Date.parse(reqDay)) / 86400000) : 0;
    if (!item.acceptedDeliveryDelay && delay > 0) add('deliveryDelay', item.productId, delay >= 2 ? 65 : 35,
      `${item.name || item.productId} will arrive on ${availDay} instead of ${reqDay}. Proceed anyway?`, ['accept_delay', 'remove_item', 'cancel']);
    const prior = last10.flatMap(o => (o.items || []).filter(i => i.productId === item.productId));
    const usualMax = prior.length ? Math.max(...prior.map(i => Number(i.quantity))) : null;
    const usualMin = prior.length ? Math.min(...prior.map(i => Number(i.quantity))) : null;
    if (usualMax && item.quantity > 1.2 * usualMax) add('quantitySpike', item.productId, 25 + 40 * (item.quantity / usualMax - 1.2),
      `You are ordering ${item.quantity} units of ${item.name || item.productId} (usual max: ${usualMax}). Confirm this quantity?`, ['reduce_to_usual_max', 'remove_item', 'cancel']);
    if (usualMin && item.quantity < 0.5 * usualMin) add('quantityDrop', item.productId, 25 + 20 * (usualMin / Math.max(item.quantity, 0.001) - 2),
      `You are ordering ${item.quantity} units of ${item.name || item.productId} (usual min: ${usualMin}). Confirm this smaller quantity?`, ['increase_to_usual_min', 'remove_item', 'cancel']);
    if (!history.some(o => (o.items || []).some(prev => prev.category === item.category))) add('newCategory', item.productId, 10,
      `${item.name || item.productId} belongs to a new category (${item.category}). Approve adding it?`, ['remove_item', 'cancel']);
  }
  if (penalties.budgetOverrun) add('budgetOverrun', null, penalties.budgetOverrun,
    `Order total is €${cartTotal.toFixed(2)} (exceeds your €${spendCap.toFixed(2)} cap). Approve this total?`, ['remove_item', 'cancel']);
  if (penalties.weeklySpend) add('weeklySpend', null, 45,
    `This order would exceed your weekly spend cap of €${Number(weeklyLimit).toFixed(2)}. Approve this total?`, ['remove_item', 'cancel']);
  return questions.sort((a,b) => b.points - a.points || a.id.localeCompare(b.id));
}
export async function createOrder(user, key, input, screening = defaultScreening) {
  const request = { ...input, items: [...input.items].sort((a, b) => a.productId.localeCompare(b.productId)) };
  const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return transaction(async db => {
    // Serialize retries for the same customer/key, including simultaneous first submissions.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([user, key])]);
    const existing = (await db.query('SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2', [user, key])).rows[0];
    if (existing) { assert(existing.request_hash === hash, 409, 'Idempotency key already used for a different order'); return existing; }
    const quote = (await db.query('SELECT * FROM quotes WHERE id=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE', [input.quote_id, user])).rows[0];
    assert(quote, 409, 'Quote missing, expired, or belongs to another user');
    assert(!(await db.query('SELECT 1 FROM quote_locks WHERE quote_id=$1', [quote.id])).rowCount, 409, 'Quote is locked by another pending mandate');
    const items = buildOrderItems(request.items, quote);
    const total = items.reduce((sum, i) => sum + i.line_total_cents, 0);
    assert(Number.isSafeInteger(total), 422, 'Order total too large');
    const policy = (await db.query('SELECT * FROM buyer_risk_policies WHERE user_id=$1', [user])).rows[0] ||
      { hard_spend_limit: 1000, weekly_spend_limit: 5000, blocked_categories: [], excluded_allergens: [] };
    const history = (await db.query("SELECT items,total_cents,created_at,routine,exclude_from_baseline FROM orders WHERE user_id=$1 AND status='APPROVED' ORDER BY created_at DESC", [user])).rows;
    for (const item of items) assert(!policy.blocked_categories.includes(item.category), 422, `Category ${item.category} is blocked for this buyer`);
    const scoredItems = items.map(i => ({ ...i, requestedDate: quote.requested_date }));
    const risk = scoreOrder(scoredItems, { policy, history });
    const reason = input.force_flag ? 'Demo: force_flag requested' : risk.decision === 'REQUIRES_INTERVENTION' ? `Risk score ${risk.score.toFixed(2)} requires human sign-off` : null;
    const status = reason ? 'PENDING_APPROVAL' : 'APPROVED';
    const routine = status === 'APPROVED' && !input.force_flag && risk.decision === 'AUTO_APPROVE';
    const result = (await db.query(`INSERT INTO orders (id,user_id,quote_id,idempotency_key,request_hash,status,flag_reason,items,currency,total_cents,mocked,requested_date,risk_score,risk_details,routine,decided_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $6='APPROVED' THEN now() ELSE NULL END) RETURNING *`,
      [randomUUID(),user,input.quote_id,key,hash,status,reason,JSON.stringify(items.map(i=>({...i,requestedDate:quote.requested_date}))),quote.currency,total,quote.mocked,quote.requested_date,risk.score,JSON.stringify(risk),routine])).rows[0];
    if (status === 'PENDING_APPROVAL') await db.query('INSERT INTO quote_locks(quote_id,order_id) VALUES($1,$2)', [quote.id,result.id]);
    await db.query('INSERT INTO order_events(order_id,user_id,status) VALUES ($1,$2,$3)', [result.id,user,status]);
    return result;
  });
}
export async function excludeOrderFromBaseline(user, orderId, exclude) {
  return transaction(async db => {
    const order = (await db.query('SELECT id,status FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE', [orderId,user])).rows[0];
    assert(order, 404, 'Order not found');
    assert(order.status === 'APPROVED', 409, 'Only approved orders can be excluded from the baseline');
    return (await db.query('UPDATE orders SET exclude_from_baseline=$1 WHERE id=$2 RETURNING *', [exclude,orderId])).rows[0];
  });
}
export async function setOrderRoutine(user, orderId, routine) {
  return transaction(async db => {
    const order = (await db.query('SELECT status FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE', [orderId,user])).rows[0];
    assert(order, 404, 'Order not found');
    assert(order.status === 'APPROVED', 409, 'Only approved orders can be classified as routine');
    return (await db.query('UPDATE orders SET routine=$1 WHERE id=$2 RETURNING *', [routine,orderId])).rows[0];
  });
}
export async function answerMandateQuestion(user, orderId, { questionId, answer, alternative }) {
  return transaction(async db => {
    const order = (await db.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE', [orderId,user])).rows[0];
    assert(order, 404, 'Order not found');
    assert(order.status === 'PENDING_APPROVAL', 409, 'Order is no longer awaiting a mandate decision');
    let details = typeof order.risk_details === 'string' ? JSON.parse(order.risk_details) : order.risk_details;
    const question = (details.questions || []).find(q => q.id === questionId);
    assert(question, 404, 'Mandate question not found');
    if (answer === 'no' && !alternative) return { order_id: orderId, question, menu: question.alternatives };
    if (answer === 'yes') {
      question.answer = 'yes';
    } else {
      assert(answer === 'no' && question.alternatives.includes(alternative), 422, 'Choose one of the listed alternatives');
      if (alternative === 'cancel') {
        const rejected = (await db.query("UPDATE orders SET status='REJECTED',decided_at=now(),risk_details=$1 WHERE id=$2 RETURNING *", [JSON.stringify(details),orderId])).rows[0];
        await db.query('INSERT INTO order_events(order_id,user_id,status) VALUES ($1,$2,$3)', [orderId,user,'REJECTED']);
        await db.query('DELETE FROM quote_locks WHERE order_id=$1', [orderId]);
        return { order: rejected, completed: true };
      }
      if (alternative === 'remove_item') {
        const removed = question.product_id ? order.items.find(i => i.productId === question.product_id) :
          [...order.items].sort((a,b) => Number(b.line_total_cents) - Number(a.line_total_cents))[0];
        assert(removed, 422, 'This question does not identify a removable item');
        order.items = order.items.filter(i => i.productId !== removed.productId);
        if (order.items.length === 0) {
          const rejected = (await db.query("UPDATE orders SET status='REJECTED',decided_at=now(),risk_details=$1 WHERE id=$2 RETURNING *", [JSON.stringify(details),orderId])).rows[0];
          await db.query('INSERT INTO order_events(order_id,user_id,status) VALUES ($1,$2,$3)', [orderId,user,'REJECTED']);
          await db.query('DELETE FROM quote_locks WHERE order_id=$1', [orderId]);
          return { order: rejected, completed: true };
        }
      } else if (alternative === 'reduce_to_usual_max') {
        const prior = (await db.query("SELECT items FROM orders WHERE user_id=$1 AND status='APPROVED' AND routine=true AND exclude_from_baseline=false ORDER BY created_at DESC LIMIT 10", [user])).rows;
        const quantities = prior.flatMap(o => o.items).filter(i => i.productId === question.product_id).map(i => Number(i.quantity));
        assert(quantities.length, 409, 'No routine quantity precedent is available');
        const item = order.items.find(i => i.productId === question.product_id);
        const lot = Number(item.allowed_lot_size);
        const usualMax = Math.max(...quantities);
        const reduced = Math.floor(usualMax / lot) * lot;
        assert(reduced > 0 && reduced < item.quantity, 409, 'No valid lower quantity is available for this lot size');
        item.quantity = reduced;
        item.line_total_cents = Math.round(Number(item.unit_price) * reduced * 100);
      } else if (alternative === 'increase_to_usual_min') {
        const prior = (await db.query("SELECT items FROM orders WHERE user_id=$1 AND status='APPROVED' AND routine=true AND exclude_from_baseline=false ORDER BY created_at DESC LIMIT 10", [user])).rows;
        const quantities = prior.flatMap(o => o.items).filter(i => i.productId === question.product_id).map(i => Number(i.quantity));
        assert(quantities.length, 409, 'No routine quantity precedent is available');
        const item = order.items.find(i => i.productId === question.product_id);
        const lot = Number(item.allowed_lot_size);
        const usualMin = Math.min(...quantities);
        const increased = Math.ceil(usualMin / lot) * lot;
        assert(increased > item.quantity, 409, 'No valid higher quantity is available for this lot size');
        item.quantity = increased;
        item.line_total_cents = Math.round(Number(item.unit_price) * increased * 100);
      } else if (alternative === 'keep_original') {
        const current = order.items.find(i => i.productId === question.product_id);
        assert(current?.orig_product_id, 409, 'The original product is not available in the substitution mapping');
        assert(!order.items.some(i => i.productId === current.orig_product_id && i.productId !== current.productId), 409, 'The original product is already in this order');
        const quote = (await db.query('SELECT items FROM quotes WHERE id=$1', [order.quote_id])).rows[0];
        const quoteItems = typeof quote.items === 'string' ? JSON.parse(quote.items) : quote.items;
        const original = quoteItems.find(i => i.productId === current.orig_product_id);
        assert(original?.orderable && original.availableAmount >= current.quantity, 409, 'The original product is not available in this quote');
        const lot = Number(original.allowed_lot_size);
        assert(Math.abs(current.quantity / lot - Math.round(current.quantity / lot)) < 1e-7, 409, 'The original product does not support this quantity');
        const restored = { ...original, quantity: current.quantity,
          line_total_cents: Math.round(Number(original.unit_price) * current.quantity * 100) };
        order.items = order.items.map(i => i.productId === current.productId ? restored : i);
      } else if (alternative === 'accept_delay') {
        const item = order.items.find(i => i.productId === question.product_id);
        if (item) item.acceptedDeliveryDelay = true;
      }
      question.answer = alternative;
      const totalCents = order.items.reduce((sum,i) => sum + Number(i.line_total_cents),0);
      const policy = (await db.query('SELECT * FROM buyer_risk_policies WHERE user_id=$1', [user])).rows[0] ||
        { hard_spend_limit: 1000, weekly_spend_limit: 5000, blocked_categories: [], excluded_allergens: [] };
      const history = (await db.query("SELECT items,total_cents,created_at,routine,exclude_from_baseline FROM orders WHERE user_id=$1 AND status='APPROVED' ORDER BY created_at DESC", [user])).rows;
      const risk = scoreOrder(order.items, { policy, history });
      const excluded = new Set(policy.excluded_allergens || []);
      if (order.items.some(i => (i.allergens || []).some(a => excluded.has(a)))) risk.penalties.allergenConflict = 60;
      risk.score = round3(Math.max(0, Object.values(risk.penalties).reduce((a,b)=>a+b,0) - Object.values(risk.discounts).reduce((a,b)=>a+b,0)));
      risk.decision = risk.score < 30 && !risk.element_scores.some(e => e.score >= 30) ? 'AUTO_APPROVE' : 'REQUIRES_INTERVENTION';
      const previousAnswers = new Map((details.questions || []).filter(q => q.answer === 'yes').map(q => [q.id,q.answer]));
      risk.questions = risk.questions.map(q => ({ ...q, answer: previousAnswers.get(q.id) || null }));
      details = risk;
      const allAnswered = details.questions.every(q => q.answer !== null);
      const status = risk.decision === 'AUTO_APPROVE' || allAnswered ? 'APPROVED' : 'PENDING_APPROVAL';
      if (status === 'APPROVED') assert((await db.query('SELECT 1 FROM quotes WHERE id=$1 AND expires_at>now()', [order.quote_id])).rowCount,
        409, 'Quote expired; reject this order and submit a new quote');
      const updated = (await db.query('UPDATE orders SET items=$1,total_cents=$2,status=$3,decided_at=CASE WHEN $3=\'APPROVED\' THEN now() ELSE NULL END,routine=CASE WHEN $3=\'APPROVED\' THEN true ELSE routine END,risk_details=$4,risk_score=$5 WHERE id=$6 RETURNING *',
        [JSON.stringify(order.items),totalCents,status,JSON.stringify(details),risk.score,orderId])).rows[0];
      if (status === 'APPROVED') await db.query('INSERT INTO order_events(order_id,user_id,status) VALUES ($1,$2,$3)', [orderId,user,status]);
      if (status !== 'PENDING_APPROVAL') await db.query('DELETE FROM quote_locks WHERE order_id=$1', [orderId]);
      return { order: updated, completed: status === 'APPROVED' };
    }
    const allAnswered = details.questions.every(q => q.answer !== null);
    const status = allAnswered ? 'APPROVED' : 'PENDING_APPROVAL';
    if (status === 'APPROVED') assert((await db.query('SELECT 1 FROM quotes WHERE id=$1 AND expires_at>now()', [order.quote_id])).rowCount,
      409, 'Quote expired; reject this order and submit a new quote');
    const updated = (await db.query('UPDATE orders SET status=$1,decided_at=CASE WHEN $1=\'APPROVED\' THEN now() ELSE NULL END,routine=CASE WHEN $1=\'APPROVED\' THEN true ELSE routine END,risk_details=$2 WHERE id=$3 RETURNING *',
      [status,JSON.stringify(details),orderId])).rows[0];
    if (status === 'APPROVED') await db.query('INSERT INTO order_events(order_id,user_id,status) VALUES ($1,$2,$3)', [orderId,user,status]);
    if (status !== 'PENDING_APPROVAL') await db.query('DELETE FROM quote_locks WHERE order_id=$1', [orderId]);
    return { order: updated, completed: status === 'APPROVED' };
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
    const updated = (await db.query('UPDATE orders SET status=$1,decided_at=now(),routine=CASE WHEN $1=\'APPROVED\' THEN true ELSE routine END WHERE id=$2 RETURNING *', [decision,orderId])).rows[0];
    await db.query('DELETE FROM quote_locks WHERE order_id=$1', [orderId]);
    await db.query('INSERT INTO order_events(order_id,user_id,status) VALUES ($1,$2,$3)', [orderId,user,decision]);
    return updated;
  });
}
