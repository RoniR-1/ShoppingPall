import 'dotenv/config';
import express from 'express';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {route} from './policy.js';
import {directLines,normalizeQuery,substitutionQuery} from './text.js';
import {ManagedAgent,enforcePriceCap} from './managed-agent.js';
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

const defaultThreshold=()=>Math.round(Number(process.env.SUSPICION_THRESHOLD??25)*1000)/1000;

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
  const raw=await r.text();
  let data;
  try{data=JSON.parse(raw);}catch{data={error:raw.slice(0,300)||r.statusText};}
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
  const rawKey=(process.env.LUNA_API_KEY||'').trim();
  const apiKey=rawKey.startsWith('Ab8RN6')?`AQ.${rawKey}`:rawKey;
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
  if(!trimmed)throw Error('Try specifying products and quantities, or describe what you want to order.');
  if(!process.env.LUNA_API_KEY){
    return planLinesSchema.parse(directLines(trimmed).map(l=>({...l,requested:`${l.quantity} ${l.query}`})));
  }
  const parsed=await callGeminiJSON(
    `You extract B2B food catalog search lines from a buyer's request.
Return ONLY valid JSON:
{"lines":[{"requested":"original item phrase with amount (e.g. 2kg apples)","query":"singular English catalog search keyword (e.g. apple)","alternatives":["plural or synonym","Finnish translation (e.g. omena)"],"quantity":2}]}
If the input does NOT mention any food, drink, product, ingredient, or dish to order (for example a greeting like "hi" or unrelated text), return:
{"lines":[],"error":"Try specifying products and quantities, or describe the dish or items you want to order."}
Rules:
1. Only include items explicitly mentioned or strictly required by a named dish/recipe. If the buyer asks for a single item (like "2kg apples" or "12 apples"), return ONLY that 1 item—never invent extra ingredients!
2. "query" and "alternatives" must contain ONLY product/ingredient names, with NO numbers or units.
3. For simple item counts without weight (e.g. "12 apples" -> ~2 kg), keep "requested" exact ("12 apples") and set "quantity" to a sensible numeric estimate.`,
    trimmed
  );
  if(!Array.isArray(parsed?.lines)||parsed.lines.length===0){
    throw Error(parsed?.error||'Try specifying products and quantities, or describe the dish or items you want to order.');
  }
  const checked=planLinesSchema.safeParse(parsed.lines);
  if(!checked.success){
    throw Error(parsed?.error||'Could not understand the order items. Try specifying products and quantities.');
  }
  return checked.data;
}

function snapToLot(qty,lot){
  const validLot=Number(lot)>0?Number(lot):1;
  const steps=Math.max(1,Math.round(Number(qty)/validLot));
  return round3(steps*validLot);
}

async function plan(lines,user,force_flag=false,approved={},demo_unavailable=false,context=null,pinned={},actionId=null){
  if(typeof pinned==='string'){actionId=pinned;pinned={};}
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
    const chosenId=approved[index]||pinned[index];
    if(!candidates.length){
      suggested=true;
      candidates=await core('/internal/suggestions',{q:line.query});
    }else if(candidates.length<4&&!chosenId){
      const extra=await core('/internal/suggestions',{q:line.query});
      const seen=new Set(candidates.map(c=>c.id));
      for(const s of extra)if(!seen.has(s.id)){candidates.push(s);seen.add(s.id);if(candidates.length>=8)break;}
    }
    if(demo_unavailable&&index===0){
      suggested=true;
      const broad=substitutionQuery(line.query);
      candidates=broad?await core('/internal/search',{q:broad,user_id:user}):[];
      candidates=candidates.filter(p=>/\bchocolate\b/i.test(p.name)&&!/\b(sauce|powder|drink|ice cream|biscuit|cookie|cake|cereal|spread)\b/i.test(p.name));
    }
    if(chosenId){
      if(!candidates.some(p=>p.id===chosenId)){
        const byId=await core('/internal/search',{q:String(chosenId),user_id:user});
        for(const p of byId)if(!candidates.some(c=>c.id===p.id))candidates.push(p);
      }
      if(!candidates.some(p=>p.id===chosenId))throw Error('Invalid substitution');
      candidates=[candidates.find(p=>p.id===chosenId),...candidates.filter(p=>p.id!==chosenId)];
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
      const eligibleLines=(Array.isArray(a?.scheduleLines)?a.scheduleLines:[]).filter(
        l=>!l.salesBlock&&(l.salesUnit==='MOCK'||l.salesUnit===p.sales_unit)&&typeof l.availableDate==='string'&&l.availableDate.slice(0,10)<=date&&Number(l.availableAmount)>0
      );
      const s=eligibleLines[0]||a?.scheduleLines?.[0];
      const cutoffOk=!a?.closingTime||(Number.isFinite(Date.parse(a.closingTime))&&Date.parse(a.closingTime)>Date.now());
      const available=a&&!a.salesBlock&&a.logisticModel==='Stock'&&eligibleLines.length>0&&cutoffOk?round3(s.availableAmount):0;
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
        available_date:typeof s?.availableDate==='string'?s.availableDate.slice(0,10):date,
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
  const selectableLines=lineOptions.filter(entry=>!entry.suggested&&entry.options.length>0&&!entry.line.manualQuantity);
  if(process.env.LUNA_API_KEY&&selectableLines.length>0&&sourceContext.getStore()==='real'){
    try{
      const promptData=selectableLines.map(entry=>{
        const forcedId=approved[entry.index]||pinned[entry.index];
        const candidatePool=forcedId&&entry.options.some(c=>c.productId===forcedId)
          ?[entry.options.find(c=>c.productId===forcedId)]
          :entry.options.slice(0,8);
        return {
          lineIndex:entry.index,
          requested:entry.line.requested||`${entry.line.quantity} ${entry.line.query}`,
          requestedQuantity:entry.line.quantity,
          candidates:candidatePool.map(c=>({
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
        };
      });
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
    const forcedId=approved[index]||pinned[index];
    const orderedOptions=forcedId&&options.some(p=>p.productId===forcedId)
      ?[options.find(p=>p.productId===forcedId),...options.filter(p=>p.productId!==forcedId)]
      :(aiPick&&options.some(p=>p.productId===aiPick.productId)
        ?[options.find(p=>p.productId===aiPick.productId),...options.filter(p=>p.productId!==aiPick.productId)]
        :options);
    const targetQty=aiPick&&orderedOptions[0]?.productId===aiPick.productId
      ?snapToLot(aiPick.quantity,orderedOptions[0].lot)
      :snapToLot(line.quantity,orderedOptions[0].lot);

    let remaining=targetQty;
    if(!suggested){
      for(const p of orderedOptions){
        if(p.price==null)continue;
        const availLeft=Math.max(0,p.available-(used.get(p.productId)||0));
        const desired=p.productId===orderedOptions[0]?.productId?remaining:snapToLot(remaining,p.lot);
        const alloc=Math.floor((Math.min(desired,availLeft)+1e-9)/p.lot)*p.lot;
        const quantity=round3(alloc);
        if(quantity<=0)continue;
        o.items.push({
          lineIndex:index,
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
          substitution:Boolean(approved[index]),
          userSelected:Boolean(pinned[index]),
          alternatives:orderedOptions
            .filter(opt=>opt.productId!==p.productId&&opt.price!=null&&opt.available>0)
            .slice(0,8)
            .map(opt=>({
              productId:opt.productId,
              name:opt.name,
              unit:opt.unit,
              lot:opt.lot,
              price:opt.price,
              available:opt.available,
              carbon:opt.carbon,
              reliability:opt.reliability
            }))
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

  o.total=round3(o.items.reduce((sum,i)=>sum+(i.lineTotal??i.quantity*i.price),0));
  o.incomplete=o.issues.length>0;
  if(context)enforcePriceCap(o.items,context);
  o.steps.push('Ranked catalog matches, prices & stock');
  const buyerHistory=await core('/internal/buyer-profile?user_id='+encodeURIComponent(user));
  const buyerCfg=await core('/internal/buyer-config?user_id='+encodeURIComponent(user));
  const threshold=round3(buyerCfg.threshold);
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

const managedAgent=new ManagedAgent({
  file:process.env.MANAGED_STATE_FILE||'.local/managed-agent.json',
  submit:(lines,user,context,id)=>sourceContext.run('demo',()=>plan(lines,user,false,{},false,context,{},id)),
  listOrders:user=>sourceContext.run('demo',()=>core('/internal/orders?user_id='+encodeURIComponent(user)))
});
const managedReady=managedAgent.load().catch(()=>{});
async function managedStatePayload(user){
  await managedReady;
  const s=managedAgent.state(user);
  const orders=await core('/internal/orders?user_id='+encodeURIComponent(user));
  return {...structuredClone(s),preview:managedAgent.preview(user),orders,simulated:true};
}

app.use('/portal/managed-agent',(req,res,next)=>{
  if(sourceContext.getStore()!=='demo')return res.status(422).json({error:'Managed agent currently supports simulated Demo warehouse only'});
  next();
});
app.get('/portal/managed-agent',async(req,res)=>{
  const user=z.string().trim().min(1).max(100).default('demo-buyer').parse(req.query.user_id);
  await managedReady;
  res.json(await managedStatePayload(user));
});
app.post('/portal/managed-agent',async(req,res)=>{
  const b=z.object({user_id:z.string().trim().min(1).max(100).default('demo-buyer'),action:z.string().min(1)}).passthrough().parse(req.body||{});
  await managedReady;
  if(b.action==='check')await managedAgent.tick(b.user_id);
  else await managedAgent.command(b.user_id,b);
  res.json(await managedStatePayload(b.user_id));
});
app.post('/portal/managed-agent/chat',async(req,res)=>{
  const b=z.object({user_id:z.string().trim().min(1).max(100).default('demo-buyer'),text:z.string().min(1).max(2000)}).parse(req.body||{});
  await managedReady;
  res.json(managedAgent.chat(b.user_id,b.text));
});
setInterval(()=>{for(const user of Object.keys(managedAgent.states))managedAgent.tick(user).catch(()=>{});},30000).unref();

app.get('/portal/catalog-overview',async(req,res)=>{
  const q=encodeURIComponent(String(req.query.q||''));
  const u=encodeURIComponent(String(req.query.user_id||'demo-buyer'));
  res.json(await core(`/internal/catalog-overview?user_id=${u}&q=${q}`));
});
app.get('/portal/buyers',async(_req,res)=>res.json(await core('/internal/buyers')));
app.post('/portal/buyers',async(req,res)=>{
  const b=z.object({
    user_id:z.string().trim().min(1).max(100),
    threshold:z.number().min(0).default(defaultThreshold())
  }).parse(req.body);
  res.json(await core('/internal/buyers',{user_id:b.user_id,threshold:round3(b.threshold),createOnly:true}));
});
app.get('/portal/config',async(req,res)=>{
  const user=String(req.query.user_id||'demo-buyer').trim()||'demo-buyer';
  const [cfg,src]=await Promise.all([
    core('/internal/buyer-config?user_id='+encodeURIComponent(user)),
    core('/internal/source')
  ]);
  res.json({user_id:cfg.user_id,threshold:round3(cfg.threshold),model:process.env.LUNA_MODEL||'gemini-2.5-flash',...src});
});
app.post('/portal/config',async(req,res)=>{
  const b=z.object({
    user_id:z.string().trim().min(1).max(100).default('demo-buyer'),
    threshold:z.number().min(0),
    stock:z.enum(['normal','low']).optional()
  }).parse(req.body);
  if(b.stock)await core('/internal/setup',{stock:b.stock});
  const saved=await core('/internal/buyers',{user_id:b.user_id,threshold:round3(b.threshold)});
  res.json({user_id:saved.user_id,threshold:round3(saved.threshold),model:process.env.LUNA_MODEL||'gemini-2.5-flash'});
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
  const {user_id,choices,quantities,removeLines,acceptPartial}=z.object({
    user_id:z.string().trim().min(1).max(100),
    choices:z.record(z.string(),z.string().min(1)).default({}),
    quantities:z.record(z.string(),z.number().positive().max(100000)).default({}),
    removeLines:z.array(z.number().int().min(0)).default([]),
    acceptPartial:z.boolean().default(false)
  }).parse(req.body||{});
  const orders=await core('/internal/orders?user_id='+encodeURIComponent(user_id));
  const o=orders.find(o=>o.id===req.params.id);
  if(!o)throw Error('Order not found');
  if(!['approve','reject','substitute'].includes(req.params.action))throw Error('Invalid action');
  if(o.status!=='PENDING_APPROVAL')throw Error('Order has already been decided');

  const hasLineEdits=Object.keys(choices).length>0||Object.keys(quantities).length>0||removeLines.length>0;
  if((req.params.action==='approve'||req.params.action==='substitute')&&hasLineEdits){
    const removeSet=new Set(removeLines);
    const nextLines=[];
    const nextApproved={};
    const nextPinned={};
    (o.lines||[]).forEach((line,oldIdx)=>{
      if(removeSet.has(oldIdx))return;
      const newIdx=nextLines.length;
      const updatedLine={...line};
      if(quantities[oldIdx]!==undefined){
        const newQty=round3(quantities[oldIdx]);
        updatedLine.quantity=newQty;
        updatedLine.manualQuantity=true;
        updatedLine.requested=`${newQty} × ${line.query}`;
      }
      const existingItem=(o.items||[]).find(i=>i.lineIndex===oldIdx);
      if(choices[oldIdx]){
        // Buyer manually selected this product from the review UI; pin it without re-flagging it as an unexpected swap.
        nextPinned[newIdx]=choices[oldIdx];
      }else if(o.approved?.[oldIdx]){
        nextApproved[newIdx]=o.approved[oldIdx];
      }else if(existingItem?.productId){
        nextPinned[newIdx]=existingItem.productId;
      }
      nextLines.push(updatedLine);
    });

    if(!nextLines.length){
      return res.json(await core('/internal/decision',{id:o.id,user_id,action:'reject',human:true}));
    }

    const keepForceFlag=req.params.action==='substitute'?Boolean(o.force_flag):false;
    const replacement=await plan(nextLines,user_id,keepForceFlag,nextApproved,o.demo_unavailable,o.context||null,nextPinned);
    await core('/internal/decision',{id:o.id,user_id,action:'reject',human:true});
    const safeToAutoFinalize=req.params.action==='approve'&&!replacement.incomplete&&replacement.items.every(i=>i.allergen_safe!==false);
    if(safeToAutoFinalize&&replacement.status!=='APPROVED'){
      return res.json(await core('/internal/decision',{id:replacement.id,user_id,action:'approve',human:true}));
    }
    return res.json(replacement);
  }
  if(req.params.action==='approve'&&o.incomplete){
    if(!acceptPartial||!o.items.length)throw Error('Select substitutions or accept the available partial order');
    o.incomplete=false;
    o.steps.push('Human accepted partial quantities');
    await core('/internal/save',o);
  }
  res.json(await core('/internal/decision',{id:o.id,user_id,action:req.params.action,human:true}));
});
app.use((e,_req,res,_next)=>{
  const msg=e instanceof z.ZodError?e.issues.map(i=>i.message).join('; '):e.message;
  res.status(422).json({error:msg||'Request failed'});
});
app.listen(Number(process.env.MIDDLE_LAYER_PORT||4002),'127.0.0.1',()=>console.log('Middle :'+(process.env.MIDDLE_LAYER_PORT||4002)));
