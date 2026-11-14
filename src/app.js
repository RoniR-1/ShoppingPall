import express from 'express';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { pool } from './db.js';
import { id, selectedRequest, orderRequest, assert } from './contracts.js';
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
    const values = [], where = ['NOT deleted'];
    const filter = (sql,value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
    if (q.q) filter('position(? in search_text)>0', q.q.toLowerCase());
    if (q.product_id) filter('id=?',q.product_id);
    if (q.category) filter('category=?',q.category);
    if (q.country) filter('country_of_origin=?',q.country);
    if (q.min_reliability !== undefined) filter('delivery_reliability>=?',q.min_reliability);
    if (q.max_carbon !== undefined) filter('carbon_kg_co2_per_kg<=?',q.max_carbon);
    values.push(q.limit);
    const products = (await pool.query(`SELECT ${columns},raw->'units' AS units FROM products WHERE ${where.join(' AND ')} ORDER BY id LIMIT $${values.length}`,values)).rows;
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
      const line = lines.find(l => l.salesBlock === false && Number.isFinite(l.availableAmount) && l.availableAmount > 0 &&
        typeof l.availableDate === 'string' &&
        (valio.mock || l.salesUnit === p.sales_unit));
      const cutoffOk = stock.closingTime == null || (Number.isFinite(Date.parse(stock.closingTime)) && Date.parse(stock.closingTime) > Date.now());
      const rawProduct = p.raw || {};
      const allergenClass = rawProduct.synkkaData?.classifications?.find(c => c.name === 'allergen');
      const allergens = (allergenClass?.values || []).filter(v => v.unit === 'CONTAINS').map(v => v.id);
      return { ...p, productId, unit_price: priced ? unitPrice : null,
        logistic_model: stock.logisticModel, allergens,
        availableAmount: line?.availableAmount ?? 0, availableDate: line?.availableDate ?? null,
        orderable: Boolean(priced && stock.salesBlock === false && line && cutoffOk),
        price, availability: stock };
    });
    const quote = (await pool.query(`INSERT INTO quotes(id,user_id,requested_date,currency,items,mocked)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(),req.user,request.requestedDate,prices.currency,JSON.stringify(items),valio.mock])).rows[0];
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
    const status = error instanceof ZodError ? 422 : error.status || 500;
    if (status >= 500) console.error(error.message);
    res.status(status).json({ error: error instanceof ZodError ? 'Invalid request' : status === 500 ? 'Internal server error' : error.message,
      ...(error instanceof ZodError ? { issues: error.issues } : {}) });
  });
  return app;
}
