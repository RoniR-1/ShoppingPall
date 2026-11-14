import 'dotenv/config';
import express from 'express';
import {closestProducts,searchTokens} from './matches.js';
import {DemoStore} from './demo-store.js';
import {pool,transaction,sourceContext,sourceName,databaseUrls} from './sources.js';
import {ValioClient} from '../valio.js';
import {productsRequest} from '../contracts.js';
const app=express();
const clients={demo:new ValioClient({mock:true,inventoryPool:pool}),real:new ValioClient({mock:false})};
const client={get mock(){return sourceName()==='demo';},price:r=>clients[sourceName()].price(r),availability:r=>clients[sourceName()].availability(r)};
app.use(express.json({limit:'1mb'}));
app.use((req,res,next)=>req.get('X-API-Key')===(process.env.CORE_API_KEY||'local-demo-key')?next():res.status(401).json({detail:'Invalid API key'}));
const portalSchema=`CREATE TABLE IF NOT EXISTS portal_orders(id uuid PRIMARY KEY,user_id text NOT NULL, body jsonb NOT NULL); CREATE TABLE IF NOT EXISTS portal_purchases(id uuid PRIMARY KEY)`;
app.use((req,res,next)=>{const source=req.get('X-Data-Source')||'demo';if(!['demo','real'].includes(source))return res.status(422).json({error:'Invalid database source'});sourceContext.run(source,next);});
const demo=new DemoStore();
app.use((req,res,next)=>{
 if(sourceName()!=='demo')return next();
 try{
  const path=req.path;
  if(req.method==='GET'&&path==='/internal/source')return res.json({source:'demo',realConfigured:Boolean(databaseUrls.real&&process.env.VALIO_API_KEY),storage:'memory'});
  if(req.method==='GET'&&path==='/internal/catalog-overview')return res.json(demo.overview());
  if(req.method==='GET'&&path==='/internal/orders')return res.json(demo.list(req.query.user_id));
  if(req.method==='POST'&&path==='/internal/suggestions')return res.json(closestProducts(req.body.q,demo.products));
  if(req.method==='POST'&&path==='/internal/search')return res.json(demo.search(req.body.q));
  if(req.method==='POST'&&path==='/internal/setup'){demo.reset(req.body.stock);return res.json({ok:true,stock:req.body.stock});}
  if(req.method==='POST'&&path==='/internal/save')return res.json(demo.save(req.body));
  if(req.method==='POST'&&path==='/internal/decision')return res.json(demo.decide(req.body));
  if(req.method==='POST'&&['/api/price','/api/availability'].includes(path))return res.json(demo.live(path.split('/').pop(),productsRequest.parse(req.body)));
  next();
 }catch(e){next(e);}
});
app.get('/internal/source',async(_req,res)=>{if(sourceName()==='real'&&!process.env.VALIO_API_KEY)throw Error('Configure VALIO_API_KEY for real availability and prices');await pool.query('SELECT id FROM products LIMIT 1');await pool.query(portalSchema);res.json({source:sourceName(),realConfigured:Boolean(databaseUrls.real&&process.env.VALIO_API_KEY)});});
app.get('/api/ping',(_,res)=>res.json({ok:true}));
for(const kind of ['price','availability']) app.post('/api/'+kind,async(req,res)=>res.json(await client[kind](productsRequest.parse(req.body))));
for(const [kind,file] of Object.entries({products:'product_data.json','carbon-footprint':'valio_aimo_junction26_carbon_footprint.csv','delivery-reliability':'valio_aimo_junction26_delivery_reliability.csv'})) app.get(`/api/${kind}/download`,(_,res)=>res.sendFile(file,{root:process.cwd()}));
app.post('/internal/setup',()=>{throw Error('Stock reset is only available in Demo mode');});
// A small, stable catalog showcase, independent of order history.
app.get('/internal/catalog-overview',async(_req,res)=>{
 const ids=['460025','460027','460131','460170','460189','460211','460239'];
 const products=(await pool.query(`SELECT p.id,p.name,p.sales_unit,p.raw->'substitutions' AS substitutions,i.quantity
 FROM products p LEFT JOIN inventory i ON i.product_id=p.id
 WHERE p.id=ANY($1) AND NOT p.deleted ORDER BY array_position($1::text[],p.id)`,[ids])).rows;
 const substituteIds=[...new Set(products.flatMap(p=>(p.substitutions||[]).filter(s=>s.product===p.id).map(s=>s.substituteProduct)))];
 const substitutes=(await pool.query(`SELECT p.id,p.name,p.sales_unit,i.quantity FROM products p
 LEFT JOIN inventory i ON i.product_id=p.id WHERE p.id=ANY($1) AND NOT p.deleted`,[substituteIds])).rows;
 if(!client.mock){const all=[...products,...substitutes];const availability=await client.availability({customer:String(_req.query.user_id||'demo-buyer'),requestedDate:new Date(Date.now()+86400000).toISOString().slice(0,10),products:[...new Set(all.map(p=>p.id))]});for(const p of all){const a=availability.products.find(a=>a.productId===p.id);const line=a?.scheduleLines?.[0];p.quantity=a?.logisticModel==='Stock'&&!a.salesBlock&&line&&!line.salesBlock?line.availableAmount:null; if(line)p.sales_unit=line.salesUnit;}}
 res.json({mocked:client.mock,products:products.map(p=>({...p,substitutions:(p.substitutions||[]).filter(s=>s.product===p.id).map(s=>substitutes.find(p=>p.id===s.substituteProduct)).filter(Boolean)}))});
});
app.post('/internal/suggestions',async(req,res)=>{
 const terms=searchTokens(String(req.body.q||'')).slice(0,20);
 if(!terms.length)return res.json([]);
 const patterns=terms.map(t=>'%'+t.slice(0,Math.max(3,t.length-2))+'%');
 const products=(await pool.query('SELECT * FROM products WHERE NOT deleted AND search_text ILIKE ANY($1::text[]) ORDER BY id LIMIT 500',[patterns])).rows;
 res.json(closestProducts(req.body.q,products));
});
app.post('/internal/search',async(req,res)=>{
 const q=String(req.body.q||'').trim(); if(!q) throw Error('Search required');
 res.json((await pool.query('SELECT * FROM products WHERE NOT deleted AND (id=$1 OR position(lower($1) in search_text)>0) ORDER BY id LIMIT 30',[q])).rows);
});
app.post('/internal/save',async(req,res)=>{
 const o=req.body; await pool.query(`INSERT INTO portal_orders VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body WHERE portal_orders.user_id=EXCLUDED.user_id AND portal_orders.body->>'status'='PENDING_APPROVAL'`,[o.id,o.user_id,o]);res.json(o);
});
app.get('/internal/orders',async(req,res)=>res.json((await pool.query('SELECT body FROM portal_orders WHERE user_id=$1',[req.query.user_id])).rows.map(r=>r.body)));
app.post('/internal/decision',async(req,res)=>res.json(await transaction(async db=>{
 const {id,user_id,action}=req.body;
 const row=(await db.query('SELECT body FROM portal_orders WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user_id])).rows[0];
 if(!row) throw Error('Order not found'); const o=row.body;
 if(o.status!=='PENDING_APPROVAL') return o;
 if(action==='reject') o.status='REJECTED';
 else {
 if(o.incomplete) throw Error('Resolve substitutions or explicitly accept the available partial quantities first');
 if(!client.mock) throw Error('Live checkout is not provided by the Valio contract');
 for(const item of [...o.items].sort((a,b)=>a.productId.localeCompare(b.productId))){
 const r=await db.query('UPDATE inventory SET quantity=quantity-$2 WHERE product_id=$1 AND quantity>=$2',[item.productId,item.quantity]);if(!r.rowCount) throw Error('Stock changed; submit a fresh request');
 }
 o.status='APPROVED';
 }
 o.steps.push(o.status==='APPROVED'?'Purchase completed · inventory updated':'Order rejected');
 await db.query('UPDATE portal_orders SET body=$2 WHERE id=$1',[id,o]);return o;
})));
app.use((e,req,res,next)=>res.status(422).json(req.path.startsWith('/api/')?{detail:[{loc:['body'],msg:e.message,type:'value_error'}]}:{error:e.message}));
app.listen(Number(process.env.BACKEND_PORT||4003),'127.0.0.1',()=>console.log('Core :'+(process.env.BACKEND_PORT||4003)));
