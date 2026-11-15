import 'dotenv/config';
import express from 'express';
import {closestProducts,searchTokens} from './matches.js';
import {DemoStore} from './demo-store.js';
import {assertQuoteCutoffs} from './quote-check.js';
import {pool,transaction,sourceContext,sourceName,databaseUrls} from './sources.js';
import {ValioClient} from '../valio.js';
import {productsRequest,round3} from '../contracts.js';
const app=express();
const useMockValio=()=>process.env.VALIO_MOCK==='true';
const clients={
  demo:new ValioClient({mock:true,inventoryPool:pool}),
  get real(){return new ValioClient({mock:useMockValio(),inventoryPool:pool});}
};
const client={get mock(){return sourceName()==='demo'||useMockValio();},price:r=>clients[sourceName()].price(r),availability:r=>clients[sourceName()].availability(r)};
app.use(express.json({limit:'1mb'}));
app.use((req,res,next)=>{const key=process.env.CORE_API_KEY||(process.env.NODE_ENV==='production'?null:'local-demo-key');if(!key)return res.status(503).json({error:'Configure CORE_API_KEY',code:'CORE_AUTH_NOT_CONFIGURED'});return req.get('X-API-Key')===key?next():res.status(401).json({detail:'Invalid API key',code:'CORE_UNAUTHORIZED'});});
const defaultThreshold=()=>round3(Number(process.env.SUSPICION_THRESHOLD??25));
const portalSchema=`CREATE TABLE IF NOT EXISTS portal_orders(id uuid PRIMARY KEY,user_id text NOT NULL, body jsonb NOT NULL); CREATE TABLE IF NOT EXISTS portal_purchases(id uuid PRIMARY KEY); CREATE TABLE IF NOT EXISTS portal_buyers(user_id text PRIMARY KEY, threshold double precision NOT NULL DEFAULT 25, created_at timestamptz NOT NULL DEFAULT now())`;
app.use((req,res,next)=>{const source=req.get('X-Data-Source')||'real';if(!['demo','real'].includes(source))return res.status(422).json({error:'Invalid database source'});sourceContext.run(source,next);});
const demo=new DemoStore();
app.use((req,res,next)=>{
 if(sourceName()!=='demo')return next();
 try{
  const path=req.path;
  if(req.method==='GET'&&path==='/internal/source')return res.json({source:'demo',realConfigured:Boolean(databaseUrls.real),storage:'memory'});
  if(req.method==='GET'&&path==='/internal/buyers')return res.json({buyers:demo.listBuyers(defaultThreshold())});
  if(req.method==='GET'&&path==='/internal/buyer-config')return res.json(demo.getBuyer(req.query.user_id||'demo-buyer',defaultThreshold()));
  if(req.method==='POST'&&path==='/internal/buyers')return res.json(demo.upsertBuyer(req.body?.user_id,req.body?.threshold??defaultThreshold(),{createOnly:Boolean(req.body?.createOnly)}));
  if(req.method==='GET'&&path==='/internal/buyer-profile'){const approved=demo.list(req.query.user_id).filter(o=>o.status==='APPROVED');const totals=approved.map(o=>Number(o.total||0)).filter(n=>n>0);const maxOrderTotal=round3(totals.length?Math.max(...totals):0);const minOrderTotal=round3(totals.length?Math.min(...totals):0);return res.json({maxOrderTotal,minOrderTotal,spendCap:round3(Math.max(200,maxOrderTotal*1.5))});}
  if(req.method==='GET'&&path==='/internal/catalog-overview')return res.json(demo.overview());
  if(req.method==='GET'&&path==='/internal/orders')return res.json(demo.list(req.query.user_id));
  if(req.method==='POST'&&path==='/internal/suggestions')return res.json(closestProducts(req.body.q,demo.products));
  if(req.method==='POST'&&path==='/internal/search')return res.json(demo.search(req.body.q,req.body.user_id||'demo-buyer'));
  if(req.method==='POST'&&path==='/internal/setup'){demo.reset(req.body.stock);return res.json({ok:true,stock:req.body.stock});}
  if(req.method==='POST'&&path==='/internal/replace')return res.json(demo.replace(req.body));
  if(req.method==='POST'&&path==='/internal/save')return res.json(demo.save(req.body));
  if(req.method==='POST'&&path==='/internal/decision')return res.json(demo.decide(req.body));
  if(req.method==='POST'&&['/api/price','/api/availability'].includes(path))return res.json(demo.live(path.split('/').pop(),productsRequest.parse(req.body)));
  next();
 }catch(e){next(e);}
});
app.get('/internal/source',async(_req,res)=>{
  const countRes=await pool.query('SELECT COUNT(*)::int AS count FROM products WHERE NOT deleted');
  await pool.query(portalSchema);
  res.json({source:sourceName(),realConfigured:Boolean(databaseUrls.real),productCount:countRes.rows[0]?.count??0,mocked:client.mock});
});
app.get('/api/ping',(_,res)=>res.json({ok:true}));
for(const kind of ['price','availability']) app.post('/api/'+kind,async(req,res)=>res.json(await client[kind](productsRequest.parse(req.body))));
for(const [kind,file] of Object.entries({products:'product_data.json','carbon-footprint':'valio_aimo_junction26_carbon_footprint.csv','delivery-reliability':'valio_aimo_junction26_delivery_reliability.csv'})) app.get(`/api/${kind}/download`,(_,res)=>res.sendFile(file,{root:process.cwd()}));
app.post('/internal/setup',async(req,res)=>{
  const stock=req.body?.stock==='low'?1:1000;
  await pool.query('UPDATE inventory SET quantity=$1',[stock]);
  res.json({ok:true,stock:req.body?.stock||'normal'});
});
async function rankedSearch(rawQuery,user='demo-buyer',limit=15){
  const q=String(rawQuery||'').trim().toLowerCase();
  if(!q)return [];
  const policy=(await pool.query('SELECT excluded_allergens,blocked_categories FROM buyer_risk_policies WHERE user_id=$1',[user])).rows[0];
  const excludedAllergens=policy?.excluded_allergens||[];
  const wordRegex=`\\m${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\M`;
  const rows=(await pool.query(`
    WITH history AS (
      SELECT product_id,
        COUNT(*)::int AS bought_count,
        COUNT(*) FILTER (WHERE is_human_approved)::int AS human_approved_count,
        COALESCE(MAX(qty), 0)::double precision AS prior_max_qty,
        COALESCE(MIN(qty), 0)::double precision AS prior_min_qty,
        COALESCE(AVG(qty), 0)::double precision AS prior_avg_qty
      FROM (
        SELECT item->>'productId' AS product_id,
          (item->>'quantity')::numeric AS qty,
          (
            o.flag_reason IS NOT NULL
            OR EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.status = 'PENDING_APPROVAL')
          ) AS is_human_approved
        FROM orders o, jsonb_array_elements(o.items) item
        WHERE o.user_id = $1 AND o.status = 'APPROVED'
        UNION ALL
        SELECT item->>'productId' AS product_id,
          (item->>'quantity')::numeric AS qty,
          COALESCE((po.body->>'human_approved')::boolean, false) AS is_human_approved
        FROM portal_orders po, jsonb_array_elements(COALESCE(po.body->'items','[]'::jsonb)) item
        WHERE po.user_id = $1 AND po.body->>'status' = 'APPROVED'
      ) combined
      GROUP BY product_id
    ),
    scored AS (
      SELECT p.id, p.name, p.category, p.country_of_origin, p.sales_unit, p.allowed_lot_size,
        ROUND(p.carbon_kg_co2_per_kg, 3) AS carbon_kg_co2_per_kg,
        ROUND(p.delivery_reliability, 3) AS delivery_reliability,
        p.raw->'units' AS units, p.raw->'substitutions' AS substitutions,
        i.quantity AS stock_quantity,
        CASE
          WHEN lower(p.name) = $3 OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(p.raw->'synkkaData'->'names', '[]'::jsonb)) n
            WHERE lower(n->>'value') = $3
          ) THEN 4
          WHEN starts_with(lower(p.name), $3) THEN 3
          WHEN p.search_text ~ $4 THEN 2
          WHEN position($3 in lower(p.name)) > 0 THEN 1
          ELSE 0
        END AS match_rank,
        COALESCE((
          SELECT array_agg(v->>'id')
          FROM jsonb_array_elements(COALESCE(p.raw->'synkkaData'->'classifications', '[]'::jsonb)) c,
               jsonb_array_elements(COALESCE(c->'values', '[]'::jsonb)) v
          WHERE c->>'name' = 'allergen' AND v->>'unit' = 'CONTAINS'
        ), '{}'::text[]) AS allergens,
        COALESCE(h.bought_count, 0) AS bought_count,
        COALESCE(h.human_approved_count, 0) AS human_approved_count,
        COALESCE(h.prior_max_qty, 0)::double precision AS prior_max_qty,
        COALESCE(h.prior_min_qty, 0)::double precision AS prior_min_qty,
        COALESCE(h.prior_avg_qty, 0)::double precision AS prior_avg_qty
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      LEFT JOIN history h ON h.product_id = p.id
      WHERE NOT p.deleted AND (p.id = $3 OR position($3 in p.search_text) > 0)
    )
    SELECT *, NOT (allergens && $2::text[]) AS allergen_safe
    FROM scored
    ORDER BY
      match_rank DESC,
      (NOT (allergens && $2::text[])) DESC,
      human_approved_count DESC,
      bought_count DESC,
      COALESCE(stock_quantity, 0) DESC,
      delivery_reliability DESC NULLS LAST,
      id ASC
    LIMIT $5`,[user,excludedAllergens,q,wordRegex,limit])).rows;
  return rows.filter(r=>!(policy?.blocked_categories||[]).includes(r.category)).map(r=>({
    ...r,
    allowed_lot_size:Number(r.allowed_lot_size),
    carbon_kg_co2_per_kg:round3(r.carbon_kg_co2_per_kg),
    delivery_reliability:round3(r.delivery_reliability),
    prior_max_qty:round3(r.prior_max_qty),
    prior_min_qty:round3(r.prior_min_qty),
    prior_avg_qty:round3(r.prior_avg_qty),
    quantity:r.stock_quantity==null?null:round3(r.stock_quantity)
  }));
}
async function seedPgBuyers(){
  await pool.query(portalSchema);
  const def=defaultThreshold();
  await pool.query(`INSERT INTO portal_buyers(user_id,threshold) VALUES('demo-buyer',$1::double precision) ON CONFLICT(user_id) DO NOTHING`,[def]);
  await pool.query(`INSERT INTO portal_buyers(user_id,threshold) SELECT DISTINCT user_id,$1::double precision FROM portal_orders WHERE NULLIF(BTRIM(user_id),'') IS NOT NULL ON CONFLICT(user_id) DO NOTHING`,[def]);
}
function normBuyerId(v){
  const id=String(v||'').trim();
  if(!id)throw Error('Buyer ID required');
  return id;
}
function normBuyerThreshold(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<0)throw Error('Invalid threshold');
  return round3(n);
}
app.get('/internal/buyers',async(_req,res)=>{
  await seedPgBuyers();
  const rows=(await pool.query(`SELECT user_id,threshold FROM portal_buyers ORDER BY created_at ASC, user_id ASC`)).rows;
  res.json({buyers:rows.map(r=>({user_id:r.user_id,threshold:round3(r.threshold)}))});
});
app.get('/internal/buyer-config',async(req,res)=>{
  await seedPgBuyers();
  const id=normBuyerId(req.query.user_id||'demo-buyer');
  const def=defaultThreshold();
  const row=(await pool.query(`SELECT user_id,threshold FROM portal_buyers WHERE user_id=$1`,[id])).rows[0];
  res.json({user_id:id,threshold:round3(row?row.threshold:def)});
});
app.post('/internal/buyers',async(req,res)=>{
  await seedPgBuyers();
  const id=normBuyerId(req.body?.user_id);
  const t=normBuyerThreshold(req.body?.threshold??defaultThreshold());
  const createOnly=Boolean(req.body?.createOnly);
  if(createOnly){
    const r=await pool.query(`INSERT INTO portal_buyers(user_id,threshold) VALUES($1,$2::double precision) ON CONFLICT(user_id) DO NOTHING RETURNING user_id,threshold`,[id,t]);
    if(!r.rowCount)throw Error(`Buyer "${id}" already exists`);
    return res.json({user_id:r.rows[0].user_id,threshold:round3(r.rows[0].threshold)});
  }
  const r=await pool.query(`INSERT INTO portal_buyers(user_id,threshold) VALUES($1,$2::double precision) ON CONFLICT(user_id) DO UPDATE SET threshold=EXCLUDED.threshold RETURNING user_id,threshold`,[id,t]);
  res.json({user_id:r.rows[0].user_id,threshold:round3(r.rows[0].threshold)});
});
app.get('/internal/buyer-profile',async(req,res)=>{
  await pool.query(portalSchema);
  const user=String(req.query.user_id||'demo-buyer');
  const row=(await pool.query(`
    SELECT
      COALESCE(MAX(total_eur), 0)::double precision AS max_total,
      COALESCE(MIN(total_eur) FILTER (WHERE total_eur > 0), 0)::double precision AS min_total
    FROM (
      SELECT (total_cents / 100.0) AS total_eur FROM orders WHERE user_id=$1 AND status='APPROVED'
      UNION ALL
      SELECT COALESCE((body->>'total')::numeric, 0) AS total_eur FROM portal_orders WHERE user_id=$1 AND body->>'status'='APPROVED'
    ) t`,[user])).rows[0];
  const maxOrderTotal=round3(row?.max_total||0);
  const minOrderTotal=round3(row?.min_total||0);
  res.json({maxOrderTotal,minOrderTotal,spendCap:round3(Math.max(200,maxOrderTotal*1.5))});
});
app.get('/internal/catalog-overview',async(req,res)=>{
  await pool.query(portalSchema);
  const q=String(req.query.q||'').trim();
  if(!q)return res.json({mocked:client.mock,products:[]});
  const products=await rankedSearch(q,String(req.query.user_id||'demo-buyer'),8);
  res.json({mocked:client.mock,products});
});
// Read-only catalog snapshot for the isolated inventory simulation. No supplier
// orders or database inventory changes are made by this endpoint.
app.get('/internal/inventory-simulation-catalog',async(req,res)=>{
  const user=String(req.query.user_id||'').trim();
  if(!user)throw Error('Buyer ID required');
  const result=await pool.query(`WITH seed AS (
      SELECT id,raw FROM products WHERE NOT deleted
      ORDER BY CASE WHEN jsonb_typeof(raw->'substitutions')='array' AND jsonb_array_length(raw->'substitutions')>0 THEN 0 ELSE 1 END,id LIMIT 500
    ), candidates AS (
      SELECT id FROM seed UNION SELECT x->>'substituteProduct' FROM seed,
        jsonb_array_elements(CASE WHEN jsonb_typeof(raw->'substitutions')='array' THEN raw->'substitutions' ELSE '[]'::jsonb END) x
      WHERE x->>'product'=seed.id AND x->>'substituteProduct' IS NOT NULL
    )
    SELECT p.id,p.name,p.category,p.sales_unit,p.allowed_lot_size,
    p.raw->'units' AS units,p.raw->>'baseUnit' AS base_unit,p.raw->'substitutions' AS substitutions,i.quantity,
    COALESCE((SELECT array_agg(v->>'id') FROM jsonb_array_elements(COALESCE(p.raw->'synkkaData'->'classifications','[]'::jsonb)) c,
      jsonb_array_elements(COALESCE(c->'values','[]'::jsonb)) v WHERE c->>'name'='allergen' AND v->>'unit'='CONTAINS'),'{}'::text[]) AS allergens
    FROM products p JOIN inventory i ON i.product_id=p.id
    WHERE p.id IN (SELECT id FROM candidates) AND NOT p.deleted AND p.allowed_lot_size>0 AND i.quantity>0
      AND NOT EXISTS (SELECT 1 FROM buyer_risk_policies b WHERE b.user_id=$1 AND
        (p.category=ANY(b.blocked_categories) OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.raw->'synkkaData'->'classifications','[]'::jsonb)) c,
          jsonb_array_elements(COALESCE(c->'values','[]'::jsonb)) v WHERE c->>'name'='allergen' AND v->>'unit'='CONTAINS' AND v->>'id'=ANY(b.excluded_allergens))))
    ORDER BY p.id`,[user]);
  res.json({products:result.rows});
});
app.post('/internal/suggestions',async(req,res)=>{
 const terms=searchTokens(String(req.body.q||'')).slice(0,20);
 if(!terms.length)return res.json([]);
 const patterns=terms.map(t=>'%'+t.slice(0,Math.max(3,t.length-2))+'%');
 const products=(await pool.query('SELECT id,name,search_text,category,sales_unit,allowed_lot_size,ROUND(carbon_kg_co2_per_kg,3) AS carbon_kg_co2_per_kg,ROUND(delivery_reliability,3) AS delivery_reliability,raw->\'units\' AS units FROM products WHERE NOT deleted AND search_text ILIKE ANY($1::text[]) ORDER BY delivery_reliability DESC NULLS LAST, id LIMIT 500',[patterns])).rows;
 res.json(closestProducts(req.body.q,products));
});
app.post('/internal/search',async(req,res)=>{
 await pool.query(portalSchema);
 const q=String(req.body.q||'').trim(); if(!q) throw Error('Search required');
 res.json(await rankedSearch(q,String(req.body.user_id||'demo-buyer'),15));
});
app.post('/internal/replace',async(req,res)=>res.json(await transaction(async db=>{
 await db.query(portalSchema);
 const {id,user_id,replacement}=req.body||{};
 const row=(await db.query('SELECT body FROM portal_orders WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user_id])).rows[0];
 if(!row||row.body.status!=='PENDING_APPROVAL')throw Error('Original order is no longer pending');
 if(!replacement||replacement.user_id!==user_id||replacement.status!=='PENDING_APPROVAL')throw Error('Invalid replacement proposal');
 const old=row.body;old.status='REJECTED';old.superseded_by=replacement.id;old.steps.push('Order replaced by a new proposal');
 await db.query('INSERT INTO portal_orders(id,user_id,body) VALUES($1,$2,$3)',[replacement.id,user_id,replacement]);
 await db.query('UPDATE portal_orders SET body=$2 WHERE id=$1',[id,old]);return replacement;
})));
app.post('/internal/save',async(req,res)=>{
 await pool.query(portalSchema);
 const o=req.body; const saved=await pool.query(`INSERT INTO portal_orders VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body WHERE portal_orders.user_id=EXCLUDED.user_id AND portal_orders.body->>'status'='PENDING_APPROVAL' RETURNING id`,[o.id,o.user_id,o]);if(!saved.rowCount)throw Error('Order cannot be replaced');res.json(o);
});
app.get('/internal/orders',async(req,res)=>{
 await pool.query(portalSchema);
 res.json((await pool.query('SELECT body FROM portal_orders WHERE user_id=$1 ORDER BY (body->>\'created_at\') DESC NULLS LAST',[req.query.user_id])).rows.map(r=>r.body));
});
app.post('/internal/decision',async(req,res)=>res.json(await transaction(async db=>{
 await db.query(portalSchema);
 const {id,user_id,action,human=false}=req.body||{};
 if(!['approve','reject'].includes(action)) throw Error('Invalid action');
 const row=(await db.query('SELECT body FROM portal_orders WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user_id])).rows[0];
 if(!row) throw Error('Order not found'); const o=row.body;
 if(o.status!=='PENDING_APPROVAL') return o;
 if(action==='reject') o.status='REJECTED';
 else {
  if(!client.mock)throw Object.assign(Error('Live supplier checkout is disabled; no supplier order was placed'),{code:'LIVE_CHECKOUT_DISABLED'});
  if(o.incomplete||!o.items?.length) throw Error('Resolve substitutions or explicitly accept the available partial quantities first');
  assertQuoteCutoffs(o.items);
   if(!o.quote_expires_at||!Number.isFinite(Date.parse(o.quote_expires_at))||Date.parse(o.quote_expires_at)<=Date.now())throw Error('Quote expired or missing; submit a new request for a fresh quote');
  if(o.items.some(item=>item.allergen_safe===false))throw Error('Product conflicts with excluded allergens; select a safe alternative');
  if(!human&&(o.context?.agent?.type!=='managed'||o.context?.confidence?.method!=='deterministic_threshold'||o.items.some(item=>item.substitution)))throw Error('Human approval is required for generated or substituted carts');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))',[user_id]);
  const policy=(await db.query('SELECT * FROM buyer_risk_policies WHERE user_id=$1',[user_id])).rows[0]||{hard_spend_limit:1000,weekly_spend_limit:5000,blocked_categories:[],excluded_allergens:[]};
  const total=Number(o.total);if(!Number.isFinite(total)||total<0||total>Number(policy.hard_spend_limit))throw Error('Order exceeds buyer hard spend limit');
  const spent=(await db.query(`SELECT COALESCE(SUM(amount),0)::double precision AS amount FROM (SELECT total_cents/100.0 AS amount FROM orders WHERE user_id=$1 AND status='APPROVED' AND created_at>=now()-interval '7 days' UNION ALL SELECT (body->>'total')::numeric AS amount FROM portal_orders WHERE user_id=$1 AND body->>'status'='APPROVED' AND (body->>'created_at')::timestamptz>=now()-interval '7 days') t`,[user_id])).rows[0];
  if(total+Number(spent.amount)>Number(policy.weekly_spend_limit))throw Error('Order exceeds buyer weekly spend limit');
  for(const item of o.items){const row=(await db.query(`SELECT p.category,COALESCE((SELECT array_agg(v->>'id') FROM jsonb_array_elements(COALESCE(p.raw->'synkkaData'->'classifications','[]'::jsonb)) c, jsonb_array_elements(COALESCE(c->'values','[]'::jsonb)) v WHERE c->>'name'='allergen' AND v->>'unit'='CONTAINS'),'{}'::text[]) AS allergens FROM products p WHERE p.id=$1 AND NOT p.deleted`,[item.productId])).rows[0];if(!row||(policy.blocked_categories||[]).includes(row.category)||(row.allergens||[]).some(a=>(policy.excluded_allergens||[]).includes(a)))throw Error('Product unavailable or conflicts with buyer policy; request a new quote');}
  for(const item of [...o.items].sort((a,b)=>a.productId.localeCompare(b.productId))){
   const r=await db.query('UPDATE inventory SET quantity=quantity-$2 WHERE product_id=$1 AND quantity>=$2',[item.productId,item.quantity]);
   if(!r.rowCount) throw Error(`Insufficient stock for ${item.name||item.productId}; re-quote the order`);
  }
  o.status='APPROVED';
  if(human) o.human_approved=true;
 }
 o.steps.push(o.status==='APPROVED'?'Order approved · inventory updated':'Order rejected');
 await db.query('UPDATE portal_orders SET body=$2 WHERE id=$1',[id,o]);return o;
})));
app.use((e,req,res,next)=>res.status(e.status||422).json(req.path.startsWith('/api/')?{error:e.message,code:e.status===429?'UPSTREAM_RATE_LIMITED':'CORE_ERROR',detail:[{loc:['body'],msg:e.message,type:'value_error'}]}:{error:e.message,code:e.code||'CORE_ERROR'}));
app.listen(Number(process.env.BACKEND_PORT||4003),'127.0.0.1',()=>console.log('Core :'+(process.env.BACKEND_PORT||4003)));
