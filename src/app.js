import express from 'express';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { pool, transaction } from './db.js';
import { appendAudit, auditActor, commercialSnapshot, verifyAuditChain, projectAuditEvent, auditCsv } from './audit.js';
import { id, selectedRequest, orderRequest, assert, round3, nutritionPer100 } from './contracts.js';
import { ValioClient } from './valio.js';
import { createOrder, decideOrder, excludeOrderFromBaseline, setOrderRoutine, answerMandateQuestion } from './orders.js';
const columns = 'id,name,category,country_of_origin,sales_unit,allowed_lot_size,carbon_kg_co2_per_kg,delivery_reliability';
export function createApp({ valio = new ValioClient(), screening } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', async (_req,res) => { await pool.query('SELECT 1'); res.json({ ok: true, mocked: valio.mock }); });
  // Local demo identity only. Replace with verified session/token identity before deployment.
  app.use((req,_res,next) => { req.user = id.parse(req.get('X-User-Id')); next(); });
  app.get('/risk-policy', async (req,res) => {
    const row = (await pool.query('SELECT * FROM buyer_risk_policies WHERE user_id=$1', [req.user])).rows[0];
    res.json(row || { user_id:req.user, hard_spend_limit:1000, weekly_spend_limit:5000, blocked_categories:[], excluded_allergens:[], defaults:true });
  });
  app.put('/risk-policy', async (req,res) => {
    const patch = z.object({
      hard_spend_limit:z.number().finite().positive().optional(), weekly_spend_limit:z.number().finite().positive().optional(),
      blocked_categories:z.array(id).max(500).optional(), excluded_allergens:z.array(id).max(500).optional()
    }).strict().refine(v => Object.keys(v).length > 0, 'Provide at least one policy field').parse(req.body);
    const old = (await pool.query('SELECT * FROM buyer_risk_policies WHERE user_id=$1', [req.user])).rows[0] ||
      { hard_spend_limit:1000, weekly_spend_limit:5000, blocked_categories:[], excluded_allergens:[] };
    const next = { ...old, ...patch };
    const row = (await pool.query(`INSERT INTO buyer_risk_policies(user_id,hard_spend_limit,weekly_spend_limit,blocked_categories,excluded_allergens)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET hard_spend_limit=EXCLUDED.hard_spend_limit,
      weekly_spend_limit=EXCLUDED.weekly_spend_limit,blocked_categories=EXCLUDED.blocked_categories,
      excluded_allergens=EXCLUDED.excluded_allergens RETURNING *`,
      [req.user,next.hard_spend_limit,next.weekly_spend_limit,next.blocked_categories,next.excluded_allergens])).rows[0];
    res.json(row);
  });
  app.get('/catalog/search', async (req,res) => {
    const q = z.object({ q: z.string().trim().min(2).max(200).optional(), product_id: id.optional(), category: id.optional(),
      country: z.string().regex(/^[a-z]{2}$/).optional(), min_reliability: z.coerce.number().min(0).max(1).optional(),
      max_carbon: z.coerce.number().min(0).optional(), limit: z.coerce.number().int().min(1).max(50).default(10)
    }).strict().parse(req.query);
    assert(q.q || q.product_id || q.category, 422, 'Provide q, product_id, or category to narrow the catalog');
    const policy = (await pool.query('SELECT excluded_allergens FROM buyer_risk_policies WHERE user_id=$1', [req.user])).rows[0];
    const excludedAllergens = policy?.excluded_allergens || [];
    const values = [req.user, excludedAllergens], where = ['NOT p.deleted'];
    const filter = (sql,value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
    if (q.q) filter('position(? in p.search_text)>0', q.q.toLowerCase());
    if (q.product_id) filter('p.id=?',q.product_id);
    if (q.category) filter('p.category=?',q.category);
    if (q.country) filter('p.country_of_origin=?',q.country);
    if (q.min_reliability !== undefined) filter('p.delivery_reliability>=?',q.min_reliability);
    if (q.max_carbon !== undefined) filter('p.carbon_kg_co2_per_kg<=?',q.max_carbon);
    let matchExpr = '0';
    if (q.q) {
      const lower = q.q.toLowerCase();
      const wordRegex = `\\m${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`;
      values.push(lower, wordRegex);
      const iExact = values.length - 1, iWord = values.length;
      matchExpr = `CASE
        WHEN lower(p.name) = $${iExact} OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p.raw->'synkkaData'->'names', '[]'::jsonb)) n
          WHERE lower(n->>'value') = $${iExact}
        ) THEN 4
        WHEN starts_with(lower(p.name), $${iExact}) THEN 3
        WHEN p.search_text ~ $${iWord} THEN 2
        WHEN position($${iExact} in lower(p.name)) > 0 THEN 1
        ELSE 0 END`;
    }
    values.push(q.limit);
    const limitParam = `$${values.length}`;
    const products = (await pool.query(`
      WITH history AS (
        SELECT item->>'productId' AS product_id,
          COUNT(*)::int AS bought_count,
          COUNT(*) FILTER (
            WHERE o.flag_reason IS NOT NULL
              OR EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.status = 'PENDING_APPROVAL')
          )::int AS human_approved_count
        FROM orders o, jsonb_array_elements(o.items) item
        WHERE o.user_id = $1 AND o.status = 'APPROVED'
        GROUP BY item->>'productId'
      ),
      scored AS (
        SELECT p.id, p.name, p.category, p.country_of_origin, p.sales_unit, p.allowed_lot_size,
          ROUND(p.carbon_kg_co2_per_kg, 3) AS carbon_kg_co2_per_kg, ROUND(p.delivery_reliability, 3) AS delivery_reliability, p.raw->'units' AS units,
          p.raw->'synkkaData'->'nutritionalContent' AS nutrition_raw,
          ${matchExpr} AS match_rank,
          COALESCE((
            SELECT array_agg(v->>'id')
            FROM jsonb_array_elements(COALESCE(p.raw->'synkkaData'->'classifications', '[]'::jsonb)) c,
                 jsonb_array_elements(COALESCE(c->'values', '[]'::jsonb)) v
            WHERE c->>'name' = 'allergen' AND v->>'unit' = 'CONTAINS'
          ), '{}'::text[]) AS allergens,
          COALESCE(h.bought_count, 0) AS bought_count,
          COALESCE(h.human_approved_count, 0) AS human_approved_count
        FROM products p
        LEFT JOIN history h ON h.product_id = p.id
        WHERE ${where.join(' AND ')}
      )
      SELECT *, NOT (allergens && $2::text[]) AS allergen_safe
      FROM scored
      ORDER BY
        match_rank DESC,
        (NOT (allergens && $2::text[])) DESC,
        human_approved_count DESC,
        bought_count DESC,
        delivery_reliability DESC NULLS LAST,
        id ASC
      LIMIT ${limitParam}`, values)).rows.map(({ nutrition_raw, ...p }) => ({ ...p, nutrition: nutritionPer100(nutrition_raw) }));
    const selectionId = randomUUID();
    const selection = (await pool.query('INSERT INTO selections(id,user_id,product_ids) VALUES ($1,$2,$3) RETURNING expires_at',
      [selectionId,req.user,products.map(p => p.id)])).rows[0];
    res.json({ selection_id: selectionId, expires_at: selection.expires_at, products });
  });
  async function selected(req) {
    const body = selectedRequest.parse(req.body);
    const rows = (await pool.query('SELECT product_ids FROM selections WHERE id=ANY($1::uuid[]) AND user_id=$2 AND expires_at>now()', [body.selection_ids,req.user])).rows;
    const allowed = new Set(rows.flatMap(r => r.product_ids));
    assert(body.products.every(p => allowed.has(p)), 422, 'Search the static catalog first; every product needs an unexpired selection for this user');
    return { customer: req.user, requestedDate: body.requestedDate, products: body.products };
  }
  for (const endpoint of ['price','availability']) app.post(`/api/${endpoint}`, async (req,res) => {
    const request = await selected(req);
    res.json({ ...await valio[endpoint](request), mocked: valio.mock });
  });
  app.post('/quotes', async (req,res) => {
    const request = await selected(req);
    const [prices, availability, catalog] = await Promise.all([
      valio.price(request), valio.availability(request),
      pool.query(`SELECT ${columns},raw FROM products WHERE id=ANY($1) AND NOT deleted`, [request.products])
    ]);
    assert(typeof prices.currency === 'string' && prices.currency.length > 0, 502, 'Missing upstream currency');
    const items = request.products.map(productId => {
      const p = catalog.rows.find(p => p.id === productId);
      const price = prices.products.find(p => p.productId === productId);
      const stock = availability.products.find(p => p.productId === productId);
      assert(p && price && stock, 502, 'Missing product in quote response');
      const unitPrice = price.priceWithTax?.value ?? price.catalogPrice?.valueWithTax;
      const priceCurrency = price.priceWithTax?.currency ?? price.catalogPrice?.currency;
      const priced = price.error === false && price.quantity === 1 && Number.isFinite(unitPrice) && unitPrice >= 0 && priceCurrency === prices.currency;
      const lines = Array.isArray(stock.scheduleLines) ? stock.scheduleLines : [];
      const line = lines.filter(l => l.salesBlock === false && Number.isFinite(l.availableAmount) && l.availableAmount > 0 &&
        typeof l.availableDate === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/i.test(l.availableDate) &&
        Number.isFinite(Date.parse(l.availableDate)) && new Date(l.availableDate.slice(0,10)).toISOString().slice(0,10) === l.availableDate.slice(0,10) &&
        (valio.mock || l.salesUnit === p.sales_unit)).sort((a,b) => a.availableDate.localeCompare(b.availableDate))[0];
      // A timestamp without an offset depends on the server's local timezone.
      const cutoffOk = stock.closingTime == null || (typeof stock.closingTime === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(stock.closingTime) && Number.isFinite(Date.parse(stock.closingTime)) && Date.parse(stock.closingTime) > Date.now());
      const rawProduct = p.raw || {};
      const allergenClass = rawProduct.synkkaData?.classifications?.find(c => c.name === 'allergen');
      const allergens = (allergenClass?.values || []).filter(v => v.unit === 'CONTAINS').map(v => v.id);
      return { ...p, productId,
        carbon_kg_co2_per_kg: round3(p.carbon_kg_co2_per_kg),
        delivery_reliability: round3(p.delivery_reliability),
        unit_price: priced ? unitPrice : null,
        logistic_model: stock.logisticModel, allergens,
        availableAmount: line?.availableAmount ?? 0, availableDate: line?.availableDate ?? null,
        orderable: Boolean(priced && stock.salesBlock === false && stock.logisticModel === 'Stock' && line && cutoffOk),
        price, availability: stock };
    });
    const quote = await transaction(async db => {
      const row = (await db.query(`INSERT INTO quotes(id,user_id,requested_date,currency,items,mocked)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(),req.user,request.requestedDate,prices.currency,JSON.stringify(items),valio.mock])).rows[0];
      await appendAudit(db, { user_id:req.user, quote_id:row.id, actor:auditActor('wholesaler_system',req.user), event_type:'QUOTE_VERIFIED',
        commercial_commitment:{ ...commercialSnapshot(items,prices.currency,0,request.requestedDate), total:null, total_eur:null, mocked:valio.mock, expires_at:row.expires_at } });
      return row;
    });
    res.status(201).json(quote);
  });
  app.post('/orders', async (req,res) => {
    const input = orderRequest.parse(req.body);
    if (req.get('X-Force-Flag') !== undefined) {
      const flag = z.enum(['true','false']).parse(req.get('X-Force-Flag'));
      input.force_flag ||= flag === 'true';
    }
    const key = id.parse(req.get('Idempotency-Key'));
    res.status(201).json(await createOrder(req.user,key,input,screening));
  });
  app.get('/audit', async (req,res) => {
    const query = z.object({ perspective:z.enum(['buyer','wholesaler']).default('buyer'), format:z.enum(['json','csv']).default('json') }).strict().parse(req.query);
    const events = (await pool.query('SELECT event FROM audit_events WHERE user_id=$1 ORDER BY sequence', [req.user])).rows.map(r => r.event);
    const verification = verifyAuditChain(events);
    const projected = events.map(e => projectAuditEvent(e,query.perspective));
    if (query.format === 'csv') return res.type('text/csv').attachment('audit-trail.csv').send(auditCsv(projected));
    res.json({ events:projected, verification, perspective:query.perspective, assurance:'Hash chain only; no independent signature or external timestamp' });
  });
  app.get('/orders', async (req,res) => {
    const query = z.object({ status: z.enum(['PENDING_APPROVAL','APPROVED','REJECTED']).default('PENDING_APPROVAL'),
      limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict().parse(req.query);
    res.json((await pool.query('SELECT * FROM orders WHERE user_id=$1 AND status=$2 ORDER BY created_at,id LIMIT $3 OFFSET $4', [req.user,query.status,query.limit,query.offset])).rows);
  });
  app.get('/orders/:orderId', async (req,res) => {
    const orderId = z.string().uuid().parse(req.params.orderId);
    const order = (await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [orderId,req.user])).rows[0];
    assert(order,404,'Order not found'); res.json(order);
  });
  app.post('/orders/:orderId/baseline-exclusion', async (req,res) => {
    const body = z.object({ exclude: z.boolean() }).strict().parse(req.body);
    res.json(await excludeOrderFromBaseline(req.user,z.string().uuid().parse(req.params.orderId),body.exclude));
  });
  app.post('/orders/:orderId/routine', async (req,res) => {
    const body = z.object({ routine:z.boolean() }).strict().parse(req.body);
    res.json(await setOrderRoutine(req.user,z.string().uuid().parse(req.params.orderId),body.routine));
  });
  app.post('/orders/:orderId/mandate', async (req,res) => {
    const body = z.object({ question_id: z.string().min(1), answer: z.enum(['yes','no']), alternative: z.string().optional() }).strict().parse(req.body);
    res.json(await answerMandateQuestion(req.user,z.string().uuid().parse(req.params.orderId),
      { questionId: body.question_id, answer: body.answer, alternative: body.alternative }));
  });
  for (const [action,status] of [['approve','APPROVED'],['reject','REJECTED']]) {
    app.post(`/orders/:orderId/${action}`, async (req,res) => {
      res.json(await decideOrder(req.user,z.string().uuid().parse(req.params.orderId),status));
    });
  }
  app.use((_req,res) => res.status(404).json({ error: 'Endpoint not found' }));
  app.use((error,_req,res,_next) => {
    const isInventoryConflict = typeof error?.message === 'string' && error.message.startsWith('Insufficient local inventory');
    const status = error instanceof ZodError ? 422 : isInventoryConflict ? 409 : error.status || 500;
    if (status >= 500) console.error(error.message);
    const code = error instanceof ZodError ? 'INVALID_REQUEST' : isInventoryConflict ? 'INSUFFICIENT_INVENTORY' :
      status === 409 && /quote/i.test(error.message) ? 'QUOTE_CONFLICT' : status === 429 ? 'UPSTREAM_RATE_LIMITED' :
      status === 502 ? 'UPSTREAM_UNAVAILABLE' : status === 503 ? 'SERVICE_UNAVAILABLE' :
      status === 422 ? 'REQUEST_NOT_FULFILLABLE' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'INTERNAL_ERROR';
    res.status(status).json({ code, error: error instanceof ZodError ? 'Invalid request' : status === 500 ? 'Internal server error' : error.message,
      ...(error instanceof ZodError ? { issues: error.issues } : {}) });
  });
  return app;
}
