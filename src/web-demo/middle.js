import 'dotenv/config';
import express from 'express';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {route} from './policy.js';
import {ManagedAgent,enforcePriceCap} from './managed-agent.js';
import {directLines,normalizeQuery,substitutionQuery} from './text.js';
import {rankCandidates} from '../agent.js';
import {round3} from '../contracts.js';

const app=express();
app.use(express.json({limit:'64kb'}));
const sourceContext=new AsyncLocalStorage();
app.use((req,res,next)=>{
  const source=req.get('X-Data-Source')||'real';
  if(!['demo','real'].includes(source))return res.status(422).json({error:'Invalid database source'});
  sourceContext.run(source,next);
});

let threshold=Number(process.env.SUSPICION_THRESHOLD??25);

async function core(path,body){
  const r=await fetch(`http://127.0.0.1:${process.env.BACKEND_PORT||4003}${path}`,{
    method:body?'POST':'GET',
    headers:{
      'Content-Type':'application/json',
      'X-Data-Source':sourceContext.getStore()||'real',
      'X-API-Key':process.env.CORE_API_KEY||'local-demo-key'
    },
    body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(120000)
  });
  const data=await r.json();
  if(!r.ok)throw Error(data.error||JSON.stringify(data.detail));
  return data;
}

const planLinesSchema=z.array(z.object({
  requested:z.string().min(1).max(200).optional(),
  query:z.string().min(1).max(200),
  alternatives:z.array(z.string().min(1).max(200)).max(4).optional(),
  quantity:z.number().positive().max(100000)
})).min(1).max(50);

const selectionSchema=z.object({
  selections:z.array(z.object({
    lineIndex:z.number().int().min(0),
    productId:z.string().min(1),
    quantity:z.number().positive().max(100000)
  }))
});

async function callGeminiJSON(systemPrompt,userPrompt){
  const base=(process.env.LUNA_BASE_URL||'https://generativelanguage.googleapis.com/v1beta/openai/').trim().replace(/\/+$/,'');
  const apiKey=process.env.LUNA_API_KEY||'';
  if(!apiKey)throw Error('Configure LUNA_API_KEY in .env to use the Gemini agent');
  const model=process.env.LUNA_MODEL||'gemini-2.5-flash';
  const r=await fetch(`${base}/chat/completions`,{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},
    body:JSON.stringify({
      model,
      temperature:0,
      messages:[
        {role:'system',content:systemPrompt},
        {role:'user',content:userPrompt}
      ],
      response_format:{type:'json_object'}
    }),
    signal:AbortSignal.timeout(60000)
  });
  const raw=await r.text();
  let response;
  try{response=JSON.parse(raw);}catch{response={error:{message:raw.slice(0,500)||r.statusText}};}
  if(Array.isArray(response))response=response[0]||{};
  if(!r.ok){
    const detail=String(response.error?.message||'Provider rejected request').replaceAll(apiKey,'[redacted]');
    throw Error(`Gemini request failed (${r.status}): ${detail}`);
  }
  const content=response.choices?.[0]?.message?.content;
  if(!content)throw Error('Gemini returned an empty response.');
  return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g,''));
}

async function parseRequestLines(text){
  const trimmed=String(text||'').trim();
  if(!trimmed)throw Error('Enter what you would like to order.');
  if(!process.env.LUNA_API_KEY){
    return planLinesSchema.parse(directLines(trimmed).map(l=>({...l,requested:`${l.quantity} ${l.query}`})));
  }
  const parsed=await callGeminiJSON(
    `You extract B2B food catalog search lines from a buyer's request.
Return ONLY valid JSON:
{"lines":[{"requested":"original item phrase with amount (e.g. 2kg apples)","query":"singular English catalog search keyword (e.g. apple)","alternatives":["plural or synonym","Finnish translation (e.g. omena)"],"quantity":2}]}
Rules:
1. Only include items explicitly mentioned or strictly required by a named dish/recipe. If the buyer asks for a single item (like "2kg apples" or "12 apples"), return ONLY that 1 item—never invent extra ingredients!
2. "query" and "alternatives" must contain ONLY product/ingredient names, with NO numbers or units.
3. For simple item counts without weight (e.g. "12 apples" -> ~2 kg), keep "requested" exact ("12 apples") and set "quantity" to a sensible numeric estimate.`,
    trimmed
  );
  return planLinesSchema.parse(parsed.lines);
}

function snapToLot(qty,lot){
  const validLot=Number(lot)>0?Number(lot):1;
  const steps=Math.max(1,Math.round(Number(qty)/validLot));
  return round3(steps*validLot);
}

async function plan(lines,user,force_flag=false,approved={},demo_unavailable=false,context=null,actionId=null){
  const o={
    id:actionId||randomUUID(),
    context,
    agent_type:context?.agent?.type||'custom',
    user_id:user,
    created_at:new Date().toISOString(),
    lines,
    force_flag,
    demo_unavailable,
    approved,
    items:[],
    issues:[],
    steps:['Parsed request with Gemini'],
    incomplete:false,
    status:'PENDING_APPROVAL'
  };
  const used=new Map();
  const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const lineOptions=[];

  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    const queries=[normalizeQuery(line.query),...(line.alternatives||[]).map(normalizeQuery)].filter(Boolean);
    let candidates=[];
    for(const q of [...new Set(queries)]){
      candidates=await core('/internal/search',{q,user_id:user});
      if(candidates.length)break;
    }
    let suggested=false;
    if(!candidates.length){
      suggested=true;
      candidates=await core('/internal/suggestions',{q:line.query});
    }
    if(demo_unavailable&&index===0){
      suggested=true;
      const broad=substitutionQuery(line.query);
      candidates=broad?await core('/internal/search',{q:broad,user_id:user}):[];
      candidates=candidates.filter(p=>/\bchocolate\b/i.test(p.name)&&!/\b(sauce|powder|drink|ice cream|biscuit|cookie|cake|cereal|spread)\b/i.test(p.name));
    }
    if(approved[index]){
      if(!candidates.some(p=>p.id===approved[index]))throw Error('Invalid substitution');
      candidates=candidates.filter(p=>p.id===approved[index]);
      suggested=false;
    }
    if(!candidates.length){
      lineOptions.push({index,line,suggested,options:[]});
      continue;
    }
    const ids=candidates.map(p=>p.id);
    const request={customer:user,requestedDate:date,products:ids};
    const [prices,stock]=await Promise.all([core('/api/price',request),core('/api/availability',request)]);
    const enriched=candidates.map(p=>{
      const price=prices.products.find(x=>x.productId===p.id);
      const a=stock.products.find(x=>x.productId===p.id);
      const s=a?.scheduleLines?.[0];
      const available=a&&!a.salesBlock&&a.logisticModel==='Stock'&&s&&(s.salesUnit==='MOCK'||s.salesUnit===p.sales_unit)&&!s.salesBlock&&s.availableDate.slice(0,10)<=date&&(!a.closingTime||Date.parse(a.closingTime)>Date.now())?round3(s.availableAmount):0;
      const unitPrice=price?.error?null:round3(price?.priceWithTax?.value??price?.catalogPrice?.valueWithTax);
      return {
        ...p,
        productId:p.id,
        unit:p.sales_unit,
        currency:price?.priceWithTax?.currency||price?.catalogPrice?.currency||prices.currency||'EUR',
        lot:round3(Number(p.allowed_lot_size)||1),
        available,
        in_stock:available>0,
        available_amount:available,
        available_date:s?.availableDate?.slice(0,10)||date,
        price:unitPrice,
        unit_price:unitPrice,
        carbon:round3(p.carbon_kg_co2_per_kg),
        reliability:round3(p.delivery_reliability)
      };
    });
    const ranked=rankCandidates(enriched);
    lineOptions.push({index,line,suggested,options:ranked});
  }

  let aiSelections=new Map();
  const selectableLines=lineOptions.filter( entry=>!entry.suggested&&entry.options.length>0&&!approved[entry.index]);
  if(process.env.LUNA_API_KEY&&selectableLines.length>0&&sourceContext.getStore()==='real'){
    try{
      const promptData=selectableLines.map(entry=>({
        lineIndex:entry.index,
        requested:entry.line.requested||`${entry.line.quantity} ${entry.line.query}`,
        requestedQuantity:entry.line.quantity,
        candidates:entry.options.slice(0,8).map(c=>({
          productId:c.productId,
          name:c.name,
          sales_unit:c.unit,
          allowed_lot_size:c.lot,
          units:c.units,
          unit_price:c.price,
          available:c.available,
          allergen_safe:c.allergen_safe,
          human_approved_count:c.human_approved_count||0,
          bought_count:c.bought_count||0
        }))
      }));
      const picked=selectionSchema.parse(await callGeminiJSON(
        `Select the single best catalog product and exact quantity in SALES UNITS for each requested line.
Return ONLY valid JSON:
{"selections":[{"lineIndex":0,"productId":"...","quantity":2}]}
Rules:
1. Candidates are already sorted best-first by keyword match, allergen safety, price, human-approved/purchase history, and stock.
2. Pick ONLY ONE productId per lineIndex from that line's candidates.
3. Convert the buyer's requested amount into the chosen product's sales_unit using its name and "units" (sizeInBaseUnits):
   - If the buyer asks for "2kg apples" or "12 apples" (~2 kg), prefer a product sold in "KG" (with quantity: 2) or a "2KG BAG" sold in "ST" (with quantity: 1)—do NOT pick a 13 kg crate ("KI") unless a crate/bulk box was requested.
4. "quantity" MUST be a positive multiple of allowed_lot_size.`,
        JSON.stringify(promptData)
      ));
      for(const sel of picked.selections)aiSelections.set(sel.lineIndex,sel);
    }catch{
      // Fallback to top ranked candidate if selection call fails
    }
  }

  for(const {index,line,suggested,options} of lineOptions){
    if(!options.length){
      o.issues.push({index,reason:'No catalog match',shortfall:round3(line.quantity),options:[]});
      continue;
    }
    const aiPick=aiSelections.get(index);
    const orderedOptions=aiPick&&options.some(p=>p.productId===aiPick.productId)
      ?[options.find(p=>p.productId===aiPick.productId),...options.filter(p=>p.productId!==aiPick.productId)]
      :options;
    const targetQty=aiPick&&orderedOptions[0]?.productId===aiPick.productId
      ?snapToLot(aiPick.quantity,orderedOptions[0].lot)
      :snapToLot(line.quantity,orderedOptions[0].lot);

    let remaining=targetQty;
    if(!suggested){
      for(const p of orderedOptions){
        if(p.price==null)continue;
        const availLeft=Math.max(0,p.available-(used.get(p.productId)||0));
        const alloc=Math.floor((Math.min(remaining,availLeft)+1e-9)/p.lot)*p.lot;
        const quantity=round3(alloc);
        if(quantity<=0)continue;
        o.items.push({
          productId:p.productId,
          name:p.name,
          unit:p.unit,
          net_contents:p.net_contents,
          currency:p.currency,
          lot:p.lot,
          quantity,
          available:p.available,
          price:p.price,
          lineTotal:round3(quantity*p.price),
          carbon:p.carbon,
          reliability:p.reliability,
          human_approved_count:p.human_approved_count||0,
          bought_count:p.bought_count||0,
          prior_max_qty:round3(p.prior_max_qty||0),
          prior_min_qty:round3(p.prior_min_qty||0),
          prior_avg_qty:round3(p.prior_avg_qty||0),
          allergen_safe:p.allergen_safe!==false,
          requested:line.requested||`${line.quantity} × ${line.query}`,
          substitution:Boolean(approved[index])
        });
        used.set(p.productId,round3((used.get(p.productId)||0)+quantity));
        remaining=round3(Math.max(0,remaining-quantity));
        if(remaining<1e-8)break;
        // Only spill over to a second SKU if the first SKU had insufficient stock
        if(availLeft>=targetQty)break;
      }
    }
    if(remaining>1e-8){
      o.issues.push({
        index,
        reason:suggested?'No exact match · choose a closest item':'Stock shortfall',
        shortfall:round3(remaining),
        options:options.slice(0,8)
      });
    }
  }

  enforcePriceCap(o.items,context);
  o.total=round3(o.items.reduce((sum,i)=>sum+(i.lineTotal??i.quantity*i.price),0));
  o.incomplete=o.issues.length>0;
  o.steps.push('Ranked catalog matches, prices & stock');
  const buyerHistory=await core('/internal/buyer-profile?user_id='+encodeURIComponent(user));
  Object.assign(o,route({...o,buyerHistory},undefined,threshold));
  o.score=round3(o.score);
  o.steps.push(`Risk score: ${o.score} / ${threshold} (${o.reason})`);

  const auto=o.status==='APPROVED';
  o.status='PENDING_APPROVAL';
  await core('/internal/save',o);
  if(auto)return core('/internal/decision',{id:o.id,user_id:user,action:'approve',human:false});
  o.steps.push('Paused for human approval');
  return core('/internal/save',o);
}

app.get('/portal/catalog-overview',async(req,res)=>{
  const q=encodeURIComponent(String(req.query.q||''));
  const u=encodeURIComponent(String(req.query.user_id||'demo-buyer'));
  res.json(await core(`/internal/catalog-overview?user_id=${u}&q=${q}`));
});
app.get('/portal/config',async(_,res)=>res.json({threshold,model:process.env.LUNA_MODEL||'gemini-2.5-flash',...await core('/internal/source')}));
app.post('/portal/config',async(req,res)=>{
  const b=z.object({threshold:z.number().min(0),stock:z.enum(['normal','low']).optional()}).parse(req.body);
  if(b.stock)await core('/internal/setup',{stock:b.stock});
  threshold=round3(b.threshold);
  res.json({threshold,model:process.env.LUNA_MODEL||'gemini-2.5-flash'});
});
app.get('/portal/orders',async(req,res)=>res.json(await core('/internal/orders?user_id='+encodeURIComponent(z.string().min(1).parse(req.query.user_id)))));
app.post('/portal/requests',async(req,res)=>{
  const b=z.object({
    user_id:z.string().min(1).max(100),
    text:z.string().max(5000).default(''),
    force_flag:z.boolean().default(false),
    demo_unavailable:z.boolean().default(false)
  }).passthrough().parse(req.body);
  const lines=await parseRequestLines(b.text);
  res.json(await plan(lines,b.user_id,b.force_flag,{},b.demo_unavailable));
});
app.post('/portal/orders/:id/:action',async(req,res)=>{
  const {user_id,choices={},acceptPartial=false}=req.body;
  const orders=await core('/internal/orders?user_id='+encodeURIComponent(user_id));
  const o=orders.find(o=>o.id===req.params.id);
  if(!o)throw Error('Order not found');
  if(!['approve','reject'].includes(req.params.action))throw Error('Invalid action');
  if(req.params.action==='approve'&&o.incomplete){
    if(Object.keys(choices).length){
      const replacement=await plan(o.lines,user_id,true,{...o.approved,...choices},o.demo_unavailable,o.context);
      await core('/internal/decision',{id:o.id,user_id,action:'reject',human:true});
      return res.json(replacement);
    }
    if(!acceptPartial||!o.items.length)throw Error('Select substitutions or accept the available partial order');
    o.incomplete=false;
    o.steps.push('Human accepted partial quantities');
    await core('/internal/save',o);
  }
  res.json(await core('/internal/decision',{id:o.id,user_id,action:req.params.action,human:true}));
});
const managed=new ManagedAgent({listOrders:user=>sourceContext.run('demo',()=>core('/internal/orders?user_id='+encodeURIComponent(user))),file:process.env.MANAGED_STATE_FILE||'.local/managed-agent.json',submit:(lines,user,context,id)=>sourceContext.run('demo',()=>plan(lines,user,false,{},false,context,id))});
await managed.load();
app.use('/portal/managed-agent',(req,res,next)=>{if(sourceContext.getStore()!=='demo')return res.status(422).json({error:'Managed agent currently supports simulated Demo warehouse only'});next();});
const managedUser=req=>z.string().min(1).max(100).parse(req.query.user_id||req.body?.user_id);
app.get('/portal/managed-agent',async(req,res)=>{const user=managedUser(req);res.json({...managed.state(user),preview:managed.preview(user),orders:await core('/internal/orders?user_id='+encodeURIComponent(user)),simulated:true});});
app.post('/portal/managed-agent',async(req,res)=>{const user=managedUser(req);if(req.body.action==='check'){await managed.tick(user);return res.json(managed.state(user));}res.json(await managed.command(user,req.body));});
app.post('/portal/managed-agent/chat',(req,res)=>{res.json(managed.chat(managedUser(req),z.string().min(1).max(500).parse(req.body.text)));});
setInterval(()=>{for(const user of Object.keys(managed.states))managed.tick(user).catch(e=>console.error('Managed check failed:',e.message));},30000).unref();
app.use((e,_req,res,_next)=>res.status(422).json({error:e.message}));
app.listen(Number(process.env.MIDDLE_LAYER_PORT||4002),'127.0.0.1',()=>console.log('Middle :'+(process.env.MIDDLE_LAYER_PORT||4002)));
