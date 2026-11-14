import 'dotenv/config';
import express from 'express';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {route} from './policy.js';
import {ManagedAgent,enforcePriceCap} from './managed-agent.js';
import {directLines,normalizeQuery,substitutionQuery} from './text.js';
const app=express();app.use(express.json({limit:'64kb'}));
const sourceContext=new AsyncLocalStorage();
app.use((req,res,next)=>{const source=req.get('X-Data-Source')||'demo';if(!['demo','real'].includes(source))return res.status(422).json({error:'Invalid database source'});sourceContext.run(source,next);});
let threshold=Number(process.env.SUSPICION_THRESHOLD||50);
async function core(path,body){const r=await fetch(`http://127.0.0.1:${process.env.BACKEND_PORT||4003}${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Data-Source':sourceContext.getStore()||'demo','X-API-Key':process.env.CORE_API_KEY||'local-demo-key'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});const data=await r.json();if(!r.ok)throw Error(data.error||JSON.stringify(data.detail));return data;}
const linesSchema=z.array(z.object({query:z.string().min(1).max(200),quantity:z.number().positive().max(100000)})).min(1).max(50);
async function parse(text,mode){
 if(mode==='agent'){
 if(!process.env.LUNA_BASE_URL)throw Error('Configure LUNA_BASE_URL and LUNA_API_KEY to use Luna 6.1');
 const r=await fetch(process.env.LUNA_BASE_URL.trim().replace(/\/+$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.LUNA_API_KEY||''}`},body:JSON.stringify({model:process.env.LUNA_MODEL||'Luna 6.1',messages:[{role:'system',content:'Return only JSON: {"lines":[{"query":"catalog search phrase","quantity":1}]}. Quantities are sales units. Do not invent product IDs. Translate a recipe into ingredient lines.'},{role:'user',content:text}],response_format:{type:'json_object'}}),signal:AbortSignal.timeout(60000)});
 const raw=await r.text();
 let response;try{response=JSON.parse(raw);}catch{response={error:{message:raw.slice(0,500)||r.statusText}};}
 if(Array.isArray(response))response=response[0]||{};
 if(!r.ok) { const detail=String(response.error?.message||'Provider rejected request').replaceAll(process.env.LUNA_API_KEY||'__no_key__','[redacted]'); throw Error(`Agent request failed (${r.status}): ${detail}`); }
 const content=response.choices?.[0]?.message?.content;
 if(!content)throw Error('Agent returned no text. Check the configured model and provider limits.');
 try{return linesSchema.parse(JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g,'')).lines);}catch{throw Error('Agent returned an invalid item list. Try a more specific request.');}
 }
 return linesSchema.parse(directLines(text));
}
async function plan(lines,user,force_flag=false,approved={},demo_unavailable=false,context=null,actionId=null){
 const o={id:actionId||randomUUID(),context,agent_type:context?.agent?.type||'custom',user_id:user,lines,force_flag,demo_unavailable,approved,items:[],issues:[],steps:['Parsed request'],incomplete:false,status:'PENDING_APPROVAL'};
 const used=new Map();const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
 for(let index=0;index<lines.length;index++){
 const line=lines[index];let candidates=await core('/internal/search',{q:normalizeQuery(line.query)});let suggested=false;
 if(!candidates.length){suggested=true;candidates=await core('/internal/suggestions',{q:line.query});}
 if(demo_unavailable&&index===0){suggested=true;const broad=substitutionQuery(line.query);candidates=broad?await core('/internal/search',{q:broad}):[];candidates=candidates.filter(p=>/\bchocolate\b/i.test(p.name)&&!/\b(sauce|powder|drink|ice cream|biscuit|cookie|cake|cereal|spread)\b/i.test(p.name));}
 if(approved[index]){if(!candidates.some(p=>p.id===approved[index]))throw Error('Invalid substitution');candidates=candidates.filter(p=>p.id===approved[index]);suggested=false;}
 if(candidates.length) candidates=candidates.filter(p=>p.sales_unit===candidates[0].sales_unit);
 if(!candidates.length){o.issues.push({index,reason:'No catalog match',shortfall:line.quantity,options:[]});continue;}
 const ids=candidates.map(p=>p.id), request={customer:user,requestedDate:date,products:ids};
 const [prices,stock]=await Promise.all([core('/api/price',request),core('/api/availability',request)]);
 const options=candidates.map(p=>{const price=prices.products.find(x=>x.productId===p.id),a=stock.products.find(x=>x.productId===p.id),s=a?.scheduleLines?.[0];const available=a&&!a.salesBlock&&a.logisticModel==='Stock'&&s&&(s.salesUnit==='MOCK'||s.salesUnit===p.sales_unit)&&!s.salesBlock&&s.availableDate.slice(0,10)<=date&&(!a.closingTime||Date.parse(a.closingTime)>Date.now())?s.availableAmount:0;return {productId:p.id,name:p.name,unit:p.sales_unit,currency:price?.priceWithTax?.currency||price?.catalogPrice?.currency||prices.currency||'EUR',lot:Number(p.allowed_lot_size),quantity:0,available,price:price?.error?null:price?.priceWithTax?.value??price?.catalogPrice?.valueWithTax,carbon:p.carbon_kg_co2_per_kg,reliability:p.delivery_reliability};});
 let remaining=line.quantity;
 if(!suggested)for(const p of options){if(p.price==null)continue;const quantity=Math.floor((Math.min(remaining,p.available-(used.get(p.productId)||0))+1e-9)/p.lot)*p.lot;if(quantity<=0)continue;o.items.push({...p,quantity,requested:line.query,substitution:Boolean(approved[index])});used.set(p.productId,(used.get(p.productId)||0)+quantity);remaining=Math.max(0,remaining-quantity);if(remaining<1e-8)break;}
 if(remaining>1e-8)o.issues.push({index,reason:suggested?'No exact match · choose a closest item':'Stock shortfall',shortfall:remaining,options});
 }
 enforcePriceCap(o.items,context);
 o.incomplete=o.issues.length>0;o.steps.push('Checked catalog, prices & stock');Object.assign(o,route(o,undefined,threshold));o.steps.push(`Risk score: ${o.score} / ${threshold}`);if(sourceContext.getStore()==='real'){o.steps.push('Real data preview · supplier checkout unavailable');o.reason+=' · Real data preview; no purchase API';o.status='PENDING_APPROVAL';}
 const auto=o.status==='APPROVED';o.status='PENDING_APPROVAL';await core('/internal/save',o);
 if(auto)return core('/internal/decision',{id:o.id,user_id:user,action:'approve'});o.steps.push('Paused for human approval');return core('/internal/save',o);
}
app.get('/portal/catalog-overview',async(req,res)=>res.json(await core('/internal/catalog-overview?user_id='+encodeURIComponent(req.query.user_id||'demo-buyer'))));
app.get('/portal/config',async(_,res)=>res.json({threshold,model:process.env.LUNA_MODEL||'Luna 6.1',...await core('/internal/source')}));
app.post('/portal/config',async(req,res)=>{const b=z.object({threshold:z.number().int().min(0).max(100),stock:z.enum(['normal','low']).optional()}).parse(req.body);if(b.stock)await core('/internal/setup',{stock:b.stock});threshold=b.threshold;res.json({threshold,model:process.env.LUNA_MODEL||'Luna 6.1'});});
app.get('/portal/orders',async(req,res)=>res.json(await core('/internal/orders?user_id='+encodeURIComponent(z.string().min(1).parse(req.query.user_id)))));
app.post('/portal/requests',async(req,res)=>{const b=z.object({user_id:z.string().min(1).max(100),text:z.string().max(5000).default(''),mode:z.enum(['direct','agent']).default('direct'),force_flag:z.boolean().default(false),demo_unavailable:z.boolean().default(false)}).parse(req.body);if(sourceContext.getStore()==='real'&&b.demo_unavailable)throw Error('Not available simulation is only enabled for the demo database');const lines=await parse(b.text,b.mode);res.json(await plan(lines,b.user_id,b.force_flag,{},b.demo_unavailable));});
app.post('/portal/orders/:id/:action',async(req,res)=>{
 const {user_id,choices={},acceptPartial=false}=req.body;const orders=await core('/internal/orders?user_id='+encodeURIComponent(user_id));const o=orders.find(o=>o.id===req.params.id);if(!o)throw Error('Order not found');
 if(!['approve','reject'].includes(req.params.action))throw Error('Invalid action');
 if(req.params.action==='approve'&&o.incomplete){
 if(Object.keys(choices).length){const replacement=await plan(o.lines,user_id,true,{...o.approved,...choices},o.demo_unavailable);await core('/internal/decision',{id:o.id,user_id,action:'reject'});return res.json(replacement);}
 if(!acceptPartial||!o.items.length)throw Error('Select substitutions or accept the available partial order');
 o.incomplete=false;o.steps.push('Human accepted partial quantities');await core('/internal/save',o);
 }
 res.json(await core('/internal/decision',{id:o.id,user_id,action:req.params.action}));
});
const managed=new ManagedAgent({listOrders:user=>sourceContext.run('demo',()=>core('/internal/orders?user_id='+encodeURIComponent(user))),file:process.env.MANAGED_STATE_FILE||'.local/managed-agent.json',submit:(lines,user,context,id)=>sourceContext.run('demo',()=>plan(lines,user,false,{},false,context,id))});
await managed.load();
app.use('/portal/managed-agent',(req,res,next)=>{if(sourceContext.getStore()!=='demo')return res.status(422).json({error:'Managed agent currently supports simulated Demo warehouse only'});next();});
const managedUser=req=>z.string().min(1).max(100).parse(req.query.user_id||req.body?.user_id);
app.get('/portal/managed-agent',async(req,res)=>{const user=managedUser(req);res.json({...managed.state(user),preview:managed.preview(user),orders:await core('/internal/orders?user_id='+encodeURIComponent(user)),simulated:true});});
app.post('/portal/managed-agent',async(req,res)=>{const user=managedUser(req);if(req.body.action==='check'){await managed.tick(user);return res.json(managed.state(user));}res.json(await managed.command(user,req.body));});
app.post('/portal/managed-agent/chat',(req,res)=>{res.json(managed.chat(managedUser(req),z.string().min(1).max(500).parse(req.body.text)));});
setInterval(()=>{for(const user of Object.keys(managed.states))managed.tick(user).catch(e=>console.error('Managed check failed:',e.message));},30000).unref();
app.use((e,req,res,next)=>res.status(422).json({error:e.message}));
app.listen(Number(process.env.MIDDLE_LAYER_PORT||4002),'127.0.0.1',()=>console.log('Middle :'+(process.env.MIDDLE_LAYER_PORT||4002)));
