import 'dotenv/config';
import express from 'express';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {route} from './policy.js';
import {directLines,normalizeQuery,substitutionQuery} from './text.js';
import {ManagedAgent,enforcePriceCap} from './managed-agent.js';
import {RealInventorySimulation} from './real-inventory-simulation.js';
import {rankCandidates,originMatches} from '../agent.js';
import {round3,parseBudget,parseDeliveryDeadline,parseSustainability,stripOrderConstraints,parseOriginPreference,countryName,parseNutritionGoals,describeNutritionGoal,NUTRIENTS} from '../contracts.js';
import {callGeminiJSON} from './luna.js';
import {allocateAvailable} from './quote-check.js';

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
  if(process.env.NODE_ENV==='production'&&!process.env.CORE_API_KEY)throw Object.assign(Error('Configure CORE_API_KEY'),{status:503,code:'CORE_AUTH_NOT_CONFIGURED'});
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
  try{data=JSON.parse(raw);}catch{const e=Error('Core returned malformed JSON');e.status=502;e.code='CORE_INVALID_RESPONSE';throw e;}
  if(!r.ok){const e=Error(data.error||JSON.stringify(data.detail)||'Core request failed');e.status=r.status;e.code=data.code||'CORE_ERROR';throw e;}
  if(!data||typeof data!=='object')throw Error('Core returned malformed JSON');
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


async function parseRequestLines(text){
if(sourceContext.getStore()==='real'&&!process.env.LUNA_API_KEY)throw Object.assign(Error('Configure LUNA_API_KEY to use agent mode'),{code:'AI_NOT_CONFIGURED'});
if(sourceContext.getStore()==='real'&&!process.env.LUNA_BASE_URL)throw Object.assign(Error('Configure LUNA_BASE_URL to use agent mode'),{code:'AI_NOT_CONFIGURED'});
// Budget, delivery window and sustainability are applied by plan(); they must not become catalog search lines.
const trimmed=stripOrderConstraints(String(text||'').trim()).trim();

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

function exactLot(qty,lot){
  if(!Number.isFinite(qty)||qty<=0||Math.abs(qty*1000-Math.round(qty*1000))>1e-8||!Number.isFinite(lot)||lot<=0||Math.abs(qty/lot-Math.round(qty/lot))>1e-8){const e=Error(`Quantity ${qty} is not a positive multiple of lot size ${lot}; adjust the request`);e.code='INVALID_LOT_QUANTITY';throw e;}
  return qty;
}

async function plan(lines,user,force_flag=false,approved={},demo_unavailable=false,context=null,pinned={},actionId=null,meta={}){
  if(typeof pinned==='string'){actionId=pinned;pinned={};}
  const budget=Number.isFinite(meta.budget)?meta.budget:parseBudget(meta.rawPrompt);
  // A stated window ("delivered in 3 days") is kept as an absolute date so re-plans after human edits keep the same deadline.
  const deliveryDeadline=meta.deliveryDeadline||parseDeliveryDeadline(meta.rawPrompt);
  const sustainability=parseSustainability(meta.rawPrompt);
  // {countries:['fi'],strict} — strict ("Finnish only") never auto-orders another origin; a preference only ranks.
  const origin=parseOriginPreference(meta.rawPrompt);
  const originLabel=origin?origin.countries.map(countryName).join(' or '):'';
  // [{nutrient:'protein',direction:'max'},...]; each is its own ranking level, earlier-mentioned first.
  const nutritionGoals=parseNutritionGoals(meta.rawPrompt);
  const parserModel=process.env.LUNA_API_KEY?(process.env.LUNA_MODEL||'gemini-2.5-flash'):'local-rule-parser';
  const o={
    id:actionId||randomUUID(),
    context,
    agent_type:context?.agent?.type||'custom',
    user_id:user,
    created_at:new Date().toISOString(),
    quote_expires_at:new Date(Date.now()+15*60*1000).toISOString(),
    raw_prompt:meta.rawPrompt||lines.map(l=>l.requested||`${l.quantity} ${l.query}`).join(', '),
    delivery_deadline:deliveryDeadline||null,
    prefers_low_carbon:sustainability,
    origin_preference:origin,
    nutrition_goals:nutritionGoals,
    parser_model:parserModel,
    lines,
    force_flag,
    demo_unavailable,
    approved,
    items:[],
    issues:[],
    line_traces:[],
    audit_trail:Array.isArray(meta.auditTrail)?[...meta.auditTrail]:[],
    steps:['Parsed request with Gemini'],
    incomplete:false,
    status:'PENDING_APPROVAL'
  };
  const used=new Map();
  const date=deliveryDeadline||new Date(Date.now()+86400000).toISOString().slice(0,10);
  const lineOptions=[];

  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    const queries=[normalizeQuery(line.query),...(line.alternatives||[]).map(normalizeQuery)].filter(Boolean);
    let candidates=[];
    let matchedQuery=queries[0]||line.query;
    for(const q of [...new Set(queries)]){
      candidates=await core('/internal/search',{q,user_id:user});
      if(candidates.length){matchedQuery=q;break;}
    }
    if(meta.managedSimulation&&context?.why?.product_id){
      candidates=candidates.filter(product=>product.id===context.why.product_id);
    }
    let suggested=false;
    const chosenId=approved[index]||pinned[index];
    if(!candidates.length){
      suggested=true;
      candidates=await core('/internal/suggestions',{q:line.query});
    }else if(candidates.length<4&&!chosenId&&!meta.managedSimulation){
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
      const byId=await core('/internal/search',{q:String(chosenId),user_id:user});
      const verified=byId.find(p=>p.id===chosenId);
      if(!verified||verified.allergen_safe!==true)throw Error('Alternative is unavailable or conflicts with buyer allergen exclusions');
      candidates=candidates.filter(p=>p.id!==chosenId);candidates.unshift(verified);
      candidates=[candidates.find(p=>p.id===chosenId),...candidates.filter(p=>p.id!==chosenId)];
      suggested=false;
    }
    if(!candidates.length){
      lineOptions.push({index,line,matchedQuery,suggested,options:[]});
      continue;
    }
    const ids=candidates.map(p=>p.id);
    const request={customer:user,requestedDate:date,products:ids};
    const [prices,stock]=await Promise.all([core('/api/price',request),core('/api/availability',request)]);
    const enriched=candidates.map(p=>{
      const price=prices.products.find(x=>x.productId===p.id);
      const a=stock.products.find(x=>x.productId===p.id);
      const eligibleLines=(Array.isArray(a?.scheduleLines)?a.scheduleLines:[]).filter(
        l=>!l.salesBlock&&((l.salesUnit==='MOCK'&&process.env.VALIO_MOCK==='true')||l.salesUnit===p.sales_unit)&&typeof l.availableDate==='string'&&l.availableDate.slice(0,10)<=date&&Number(l.availableAmount)>0
      );
      const s=eligibleLines[0]||a?.scheduleLines?.[0];
      const cutoffOk=!a?.closingTime||(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(a.closingTime)&&Number.isFinite(Date.parse(a.closingTime))&&Date.parse(a.closingTime)>Date.now());
      const available=a&&!a.salesBlock&&a.logisticModel==='Stock'&&eligibleLines.length>0&&cutoffOk?Number(s.availableAmount):0;
      const amount=price?.priceWithTax?.value??price?.catalogPrice?.valueWithTax;
      const currency=price?.priceWithTax?.currency||price?.catalogPrice?.currency;
      const unitPrice=price?.error||!Number.isFinite(amount)||amount<0||price?.quantity!==1||!currency||currency!==prices.currency?null:amount;
      return {
        ...p,
        productId:p.id,
        unit:p.sales_unit,
        currency,
        lot:Number(p.allowed_lot_size),
        available,
        closing_time:a?.closingTime??null,
        in_stock:available>0,
        available_amount:available,
        available_date:typeof s?.availableDate==='string'?s.availableDate.slice(0,10):date,
        price:unitPrice,
        unit_price:unitPrice,
        carbon:round3(p.carbon_kg_co2_per_kg),
        reliability:round3(p.delivery_reliability),
        // Ranks high for a stated deadline, otherwise as a minor factor after price (default date).
        deliverable_by_date:available>0
      };
    });
    const ranked=rankCandidates(enriched,{deliveryRequested:Boolean(deliveryDeadline),sustainability,origins:origin?.countries,nutrition:nutritionGoals});
    // Strict origin: other origins are only offered to the reviewer, never auto-ordered. A human-chosen product is kept.
    const allowed=origin?.strict?ranked.filter(p=>originMatches(p,origin.countries)||p.productId===chosenId):ranked;
    lineOptions.push({index,line,matchedQuery,suggested,options:allowed,originBlocked:allowed.length?null:ranked.slice(0,8)});
  }

  let aiSelections=new Map();
  const selectableLines=lineOptions.filter(entry=>!entry.suggested&&entry.options.length>0&&!entry.line.manualQuantity);
  if(process.env.LUNA_API_KEY&&selectableLines.length>0&&sourceContext.getStore()==='real'){
    try{
      const promptData=selectableLines.map(entry=>{
        const forcedId=approved[entry.index]||pinned[entry.index];
        const candidatePool=forcedId&&entry.options.some(c=>c.productId===forcedId)
          ?[entry.options.find(c=>c.productId===forcedId)]
          :entry.options.slice(0,5);
        return {
          lineIndex:entry.index,
          requested:entry.line.requested||`${entry.line.quantity} ${entry.line.query}`,
          requestedQuantity:entry.line.quantity,
          totalBudgetEUR:budget,
          candidates:candidatePool.map(c=>({
            productId:c.productId,
            name:c.name,
            sales_unit:c.unit,
            allowed_lot_size:c.lot,
            units:c.units,
            unit_price:c.price,
            available:c.available,
            ...(deliveryDeadline?{deliverable_by_deadline:c.deliverable_by_date}:{}),
            ...(sustainability?{carbon_kg_co2_per_kg:c.carbon??null}:{}),
            ...(origin?{country_of_origin:c.country_of_origin??null}:{}),
            ...(nutritionGoals.length?{nutrition_per_100:Object.fromEntries(nutritionGoals.map(({nutrient})=>[`${NUTRIENTS[nutrient].label} (${NUTRIENTS[nutrient].unit})`,c.nutrition?.[nutrient]??null]))}:{}),
            allergen_safe:c.allergen_safe,
            human_approved_count:c.human_approved_count||0,
            bought_count:c.bought_count||0
          }))
        };
      });
      const selectionRules=
        `Select the single best catalog product and exact quantity in SALES UNITS for each requested line.
Return ONLY valid JSON:
{"selections":[{"lineIndex":0,"productId":"...","quantity":2}]}
Rules:
1. Candidates are already sorted best-first by keyword match, allergen safety, ${origin?'requested country of origin, ':''}${deliveryDeadline?'deliverability by the requested deadline, ':''}${nutritionGoals.length?`nutrition (${nutritionGoals.map(describeNutritionGoal).join(', then ')}), `:''}${sustainability?'lowest CO2 per kg, ':''}price, ${deliveryDeadline?'':'availability by the default date, '}${sustainability?'':'lower CO2, '}human-approved/purchase history, and stock.
2. Pick ONLY ONE productId per lineIndex from that line's candidates.
3. Convert the buyer's requested amount into the chosen product's sales_unit using its name and "units" (sizeInBaseUnits):
   - If the buyer asks for "2kg apples" or "12 apples" (~2 kg), prefer a product sold in "KG" (with quantity: 2) or a "2KG BAG" sold in "ST" (with quantity: 1)—do NOT pick a 13 kg crate ("KI") unless a crate/bulk box was requested.
4. "quantity" MUST be a positive multiple of allowed_lot_size.
${origin?`5o. The buyer ${origin.strict?'accepts ONLY':'prefers'} products whose country_of_origin is ${origin.countries.join(' or ')} (${originLabel}).${origin.strict?' Every candidate shown already matches.':' Prefer those; never pick a worse keyword match just to match the origin.'}\n`:''}${nutritionGoals.length?`5n. The buyer wants ${nutritionGoals.map(describeNutritionGoal).join(', then ')} (nutrition_per_100 is per 100 g or 100 ml; null = unknown). Prefer accordingly; never pick a worse keyword match just to improve nutrition.\n`:''}${deliveryDeadline?`5a. The buyer wants delivery by ${deliveryDeadline}. Prefer candidates with deliverable_by_deadline true; never pick a worse keyword match just to meet the deadline.\n`:''}${sustainability?`5b. The buyer wants sustainable choices. Prefer the lowest carbon_kg_co2_per_kg (kg CO2-eq per kg; null = unknown); never pick a worse keyword match just to lower CO2.\n`:''}5. ${budget==null?'No total budget was specified.':`The buyer specified a TOTAL budget of EUR ${budget.toFixed(2)} for the whole order. Choose the lowest-cost suitable candidates across all lines while preserving requested quantities. Do not pretend an over-budget cart is within budget; the system will send it for human approval.`}`;
  // Rough cart cost for a set of picks, mirroring the allocation below (suggested lines are never auto-ordered).
  const estimate=selections=>lineOptions.reduce((sum,entry)=>{
    if(sum==null||entry.suggested||!entry.options.length)return sum;
    const sel=selections.get(entry.index);
    const option=entry.options.find(o=>o.productId===sel?.productId);
    const forcedId=approved[entry.index]||pinned[entry.index];
    const chosen=option||entry.options.find(o=>o.productId===forcedId)||entry.options.find(o=>o.price!=null);
    if(!chosen||chosen.price==null)return null;
    return sum+chosen.price*Number(option?sel.quantity:entry.line.quantity);

  },0);
  const validSelections=picked=>{
    const selections=new Map();
    for(const sel of picked.selections){const entry=selectableLines.find(e=>e.index===sel.lineIndex);const forced=approved[sel.lineIndex]||pinned[sel.lineIndex];const allowed=forced?entry?.options.filter(c=>c.productId===forced):entry?.options.slice(0,8);if(!entry||selections.has(sel.lineIndex)||!allowed.some(c=>c.productId===sel.productId))throw Error('Invalid or duplicate product selection');selections.set(sel.lineIndex,sel);}
    if(selections.size!==selectableLines.length)throw Error('Missing product selection');
    return selections;
  };
  let feedback='';
  let bestCost=Infinity;
  for(let attempt=0;attempt<(budget==null?1:2);attempt++){
    let selections;
    // A failed first attempt fails closed; a failed budget retry keeps the first valid selection.
    try{selections=validSelections(selectionSchema.parse(await callGeminiJSON(selectionRules+feedback,JSON.stringify(promptData))));}
    catch(e){if(attempt)break;throw e;}
    const cost=budget==null?0:estimate(selections);
    // Keep the cheaper of the first pick and the budget retry; unpriced picks cannot be compared.
    if(attempt===0||(cost!=null&&cost<bestCost)){aiSelections=selections;bestCost=cost??Infinity;}
    if(budget==null||cost==null||Math.round(cost*100)<=Math.round(budget*100))break;
    o.steps.push(`Selection estimated at €${cost.toFixed(2)} exceeds the €${budget.toFixed(2)} budget; asking the model for cheaper options.`);
    feedback=`\n6. Your previous selection costs about EUR ${cost.toFixed(2)}, which is over the EUR ${budget.toFixed(2)} budget. Choose cheaper suitable (allergen-safe, same item) candidates and the smallest quantities that still cover each requested line. Do not drop lines. If the budget cannot be met, return the cheapest complete selection.`;
  }
  }catch(e){throw Object.assign(Error(`Product selection failed: ${e.message}`),{code:e.code||'AI_SELECTION_FAILED',status:e.status});}

  }

  for(const {index,line,matchedQuery,suggested,options,originBlocked} of lineOptions){
    if(!options.length){
      if(originBlocked?.length){
        // Matches exist, but none from the required origin: send the line to human review with the other origins offered.
        o.line_traces.push({
          lineIndex:index,
          requested:line.requested||`${line.quantity} × ${line.query}`,
          query:line.query,
          alternatives:line.alternatives||[],
          matchedQuery:matchedQuery||line.query,
          totalCandidates:originBlocked.length,
          selectionMode:'origin-blocked',
          selectedProductId:null,
          selectedName:null,
          selectedQty:round3(line.quantity),
          selectedUnit:null,
          topCandidates:originBlocked.slice(0,3).map(c=>({productId:c.productId,name:c.name,unit:c.unit,lot:c.lot,price:c.price,available:c.available,
            allergen_safe:c.allergen_safe!==false,country_of_origin:c.country_of_origin??null,nutrition:c.nutrition||{},carbon:c.carbon,match_rank:c.match_rank??null}))
        });
        o.issues.push({index,reason:`No product from ${originLabel} available`,shortfall:round3(line.quantity),options:originBlocked});
        o.steps.push(`"${line.requested||line.query}": no product from ${originLabel}; sent for human review.`);
        continue;
      }
      o.line_traces.push({
        lineIndex:index,
        requested:line.requested||`${line.quantity} × ${line.query}`,
        query:line.query,
        alternatives:line.alternatives||[],
        matchedQuery:matchedQuery||line.query,
        totalCandidates:0,
        selectionMode:'no-match',
        selectedProductId:null,
        selectedName:null,
        selectedQty:round3(line.quantity),
        selectedUnit:null,
        topCandidates:[]
      });
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
      ?exactLot(aiPick.quantity,orderedOptions[0].lot)
      :exactLot(line.quantity,orderedOptions[0].lot);

    o.line_traces.push({
      lineIndex:index,
      requested:line.requested||`${line.quantity} × ${line.query}`,
      query:line.query,
      alternatives:line.alternatives||[],
      matchedQuery:matchedQuery||line.query,
      totalCandidates:options.length,
      selectionMode:approved[index]
        ?'human-substitution'
        :pinned[index]
          ?'human-pinned'
          :(aiPick&&orderedOptions[0]?.productId===aiPick.productId)
            ?'gemini-selection'
            :suggested
              ?'fallback-suggestions'
              :'top-ranked',
      selectedProductId:orderedOptions[0]?.productId||null,
      selectedName:orderedOptions[0]?.name||null,
      selectedQty:targetQty,
      selectedUnit:orderedOptions[0]?.unit||null,
      topCandidates:orderedOptions.slice(0,3).map(c=>({
        productId:c.productId,
        name:c.name,
        unit:c.unit,
        lot:c.lot,
        price:c.price,
        available:c.available,
        allergen_safe:c.allergen_safe!==false,
        bought_count:c.bought_count||0,
        human_approved_count:c.human_approved_count||0,
        reliability:c.reliability,
        carbon:c.carbon,
        country_of_origin:c.country_of_origin??null,
        nutrition:c.nutrition||{},
        match_rank:c.match_rank??null
      }))
    });

    let remaining=targetQty;
    if(!suggested){
      for(const p of orderedOptions.slice(0,1)){
        if(p.price==null||p.allergen_safe!==true)continue;
        const availLeft=Math.max(0,p.available-(used.get(p.productId)||0));
        const desired=p.productId===orderedOptions[0]?.productId?remaining:exactLot(remaining,p.lot);
        const alloc=allocateAvailable(desired,availLeft,p.lot);
        const quantity=alloc;
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
          closing_time:p.closing_time,
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
        used.set(p.productId,(used.get(p.productId)||0)+quantity);
        remaining=Math.max(0,remaining-quantity);
        if(remaining<=0)break;
        // Only spill over to a second SKU if the first SKU had insufficient stock
        if(availLeft>=targetQty)break;
      }
    }
    if(remaining>0){
      o.issues.push({
        index,
        reason:suggested?'No exact match · choose a closest item':'Stock shortfall',
        shortfall:remaining,
        options:options.slice(0,8)
      });
    }
  }

  // A simulated replenishment is a single product request. Do not create an
  // approval order when there is no complete, policy-eligible supplier quote.
  if(meta.managedSimulation&&o.issues.length){
    const issue=o.issues[0], line=lines[issue.index], candidate=o.line_traces.find(t=>t.lineIndex===issue.index)?.topCandidates?.[0];
    const reason=issue.reason.startsWith('No catalog match')?'no matching supplier product':
      candidate?.allergen_safe===false?'product conflicts with the buyer allergen policy':
      candidate?.price==null?'no valid supplier quote':
      issue.reason.startsWith('No exact match')?'no exact supplier match':'supplier stock is insufficient';
    throw Object.assign(Error(`${line.query}: replenishment blocked because ${reason}.`),{code:'REPLENISHMENT_BLOCKED'});
  }
  o.total=round3(o.items.reduce((sum,i)=>sum+(i.lineTotal??i.quantity*i.price),0));
  if(budget!=null){
    o.budget_limit=round3(budget);
    o.budget_overrun=Math.round(o.total*100)>Math.round(budget*100);
    if(o.budget_overrun)o.steps.push(`Total €${o.total.toFixed(2)} exceeds the stated €${budget.toFixed(2)} budget; human approval required.`);
  }
  o.incomplete=o.issues.length>0;
  let policyBreach=null;
  if(context){try{enforcePriceCap(o.items,context);}catch(e){if(e.code!=='PRICE_CAP'||!meta.managedSimulation)throw e;policyBreach=e.message;o.policy_breach=policyBreach;}}
  o.steps.push('Ranked catalog matches, prices & stock');
  const buyerHistory=await core('/internal/buyer-profile?user_id='+encodeURIComponent(user));
  const buyerCfg=await core('/internal/buyer-config?user_id='+encodeURIComponent(user));
  const threshold=round3(buyerCfg.threshold);
  o.buyer_baseline=buyerHistory;
  Object.assign(o,route({...o,buyerHistory},undefined,threshold));
  o.score=round3(o.score);
  o.steps.push(`Risk score: ${o.score} / ${threshold} (${o.reason})`);

  const eligible=context?.agent?.type==='managed'&&context?.confidence?.method==='deterministic_threshold'&&!o.incomplete&&o.items.every(i=>!i.substitution&&i.allergen_safe!==false);
  const auto=!meta.auditTrail&&eligible&&(meta.managedSimulation?(context.simulation?.governance==='autonomous'&&!policyBreach):o.status==='APPROVED');
  if(policyBreach)o.reason=`Price cap review required: ${policyBreach}`;
  else if(meta.managedSimulation&&context.simulation?.governance==='human')o.reason='Human-in-the-loop review required';
  o.status='PENDING_APPROVAL';
  if(auto){
    o.audit_trail.push({at:new Date().toISOString(),actor:'gatekeeper',text:meta.managedSimulation?`Auto-approved under simulation governance after price-cap validation (risk score ${o.score}; buyer threshold ${threshold}).`:`Auto-approved: risk score ${o.score} is within buyer "${user}" threshold of ${threshold}.`});
  }else{
    o.audit_trail.push({at:new Date().toISOString(),actor:'gatekeeper',text:`Queued for human review: risk score ${o.score}, threshold ${threshold} (${o.reason}).`});
  }
  if(meta.prepareOnly)return o;
  await core('/internal/save',o);
  if(auto)return core('/internal/decision',{id:o.id,user_id:user,action:'approve',human:false});
  o.steps.push('Paused for human approval');
  return core('/internal/save',o);
}

const managedAgent=new ManagedAgent({
  file:process.env.MANAGED_STATE_FILE||'.local/managed-agent.json',
  submit:(lines,user,context,id)=>sourceContext.run('demo',()=>plan(lines,user,false,{},false,context,{},id,{managedSimulation:Boolean(context.simulation)})),
  listOrders:user=>sourceContext.run('demo',()=>core('/internal/orders?user_id='+encodeURIComponent(user)))
});
const managedReady=managedAgent.load();
async function managedStatePayload(user){
  await managedReady;
  const s=managedAgent.state(user);
  const orders=await core('/internal/orders?user_id='+encodeURIComponent(user));
  return {...structuredClone(s),preview:managedAgent.preview(user),orders,simulated:true};
}

const realInventory=new RealInventorySimulation({
  file:process.env.REAL_INVENTORY_STATE_FILE||'.local/agent-managed-inventory-real.json',
  catalog:async user=>{
    try{return (await sourceContext.run('real',()=>core('/internal/inventory-simulation-catalog?user_id='+encodeURIComponent(user)))).products;}
    catch(e){throw Object.assign(Error('Cannot load the database catalog. Check REAL_DATABASE_URL and database availability.'),{status:503,code:'CATALOG_UNAVAILABLE'});}
  }
});
const realInventoryReady=realInventory.load();
const realUser=value=>z.string().trim().min(1).max(100).default('demo-buyer').parse(value);
app.get('/portal/agent-managed-inventory',async(req,res,next)=>{
  if(sourceContext.getStore()!=='real')return next();
  const user=realUser(req.query.user_id);await realInventoryReady;await realInventory.initialize(user);res.json(realInventory.snapshot(user));
});
app.post('/portal/agent-managed-inventory',async(req,res,next)=>{
  if(sourceContext.getStore()!=='real')return next();
  const body=z.object({user_id:z.string().trim().min(1).max(100).default('demo-buyer'),action:z.string().min(1)}).passthrough().parse(req.body||{});
  await realInventoryReady;await realInventory.initialize(body.user_id);res.json(await realInventory.command(body.user_id,body));
});
app.post('/portal/agent-managed-inventory/chat',async(req,res,next)=>{
  if(sourceContext.getStore()!=='real')return next();
  const body=z.object({user_id:z.string().trim().min(1).max(100).default('demo-buyer'),text:z.string().min(1).max(2000)}).parse(req.body||{});
  await realInventoryReady;await realInventory.initialize(body.user_id);res.json(realInventory.chat(body.user_id,body.text));
});
const realSimulationInFlight=new Set();
setInterval(()=>{for(const user of Object.keys(realInventory.states)){if(realSimulationInFlight.has(user))continue;realSimulationInFlight.add(user);realInventory.simulationStep(user).catch(()=>{}).finally(()=>realSimulationInFlight.delete(user));}},250).unref();

app.use((req,_res,next)=>{if(/^\/portal\/agent-managed-inventory(?=\/|\?|$)/.test(req.url))req.url=req.url.replace('/portal/agent-managed-inventory','/portal/managed-agent');next();});
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
  else {await managedAgent.command(b.user_id,b);if(['simulation','consume','demand_spike'].includes(b.action)||(managedAgent.state(b.user_id).simulation&&['snapshot','rule'].includes(b.action)))await managedAgent.tick(b.user_id);}
  res.json(await managedStatePayload(b.user_id));
});
app.post('/portal/managed-agent/chat',async(req,res)=>{
  const b=z.object({user_id:z.string().trim().min(1).max(100).default('demo-buyer'),text:z.string().min(1).max(2000)}).parse(req.body||{});
  await managedReady;
  res.json(managedAgent.chat(b.user_id,b.text));
});
const simulationInFlight=new Set();
setInterval(()=>{for(const [user,state] of Object.entries(managedAgent.states)){if(!state.simulation||simulationInFlight.has(user))continue;simulationInFlight.add(user);managedAgent.simulationStep(user).catch(()=>{}).finally(()=>simulationInFlight.delete(user));}},250).unref();
setInterval(()=>{for(const [user,state] of Object.entries(managedAgent.states))if(!state.simulation)managedAgent.tick(user).catch(()=>{});},30000).unref();

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
  res.json(await plan(lines,b.user_id,b.force_flag,{},b.demo_unavailable,null,{},null,{rawPrompt:b.text,budget:parseBudget(b.text)}));
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

  const priorTrail=Array.isArray(o.audit_trail)?[...o.audit_trail]:[];
  const nowIso=()=>new Date().toISOString();

  const hasLineEdits=Object.keys(choices).length>0||Object.keys(quantities).length>0||removeLines.length>0;
  if((req.params.action==='approve'||req.params.action==='substitute')&&hasLineEdits){
    const removeSet=new Set(removeLines);
    const nextLines=[];
    const nextApproved={};
    const nextPinned={};
    (o.lines||[]).forEach((line,oldIdx)=>{
      const existingItem=(o.items||[]).find(i=>i.lineIndex===oldIdx);
      if(removeSet.has(oldIdx)){
        priorTrail.push({at:nowIso(),actor:user_id,text:`Removed item "${existingItem?.name||line.query}" from the order.`});
        return;
      }
      const newIdx=nextLines.length;
      const updatedLine={...line};
      if(quantities[oldIdx]!==undefined){
        const newQty=quantities[oldIdx];
        priorTrail.push({at:nowIso(),actor:user_id,text:`Adjusted quantity for "${existingItem?.name||line.query}" from ${existingItem?.quantity??line.quantity} to ${newQty}.`});
        updatedLine.quantity=newQty;
        updatedLine.manualQuantity=true;
        updatedLine.requested=`${newQty} × ${line.query}`;
      }
      if(choices[oldIdx]){
        if(sourceContext.getStore()==='real')throw Error('Live substitutions require a policy-validated quote; use the procurement API to request one');
        const offered=[...(o.issues||[]).filter(i=>i.index===oldIdx).flatMap(i=>i.options||[]),...(o.items||[]).filter(i=>i.lineIndex===oldIdx).flatMap(i=>i.alternatives||[])];
        if(!offered.some(item=>(item.productId||item.id)===choices[oldIdx]))throw Error('Select an offered alternative and request a new quote');
        priorTrail.push({at:nowIso(),actor:user_id,text:`Swapped item "${existingItem?.name||line.query}" to product #${choices[oldIdx]}.`});
        nextPinned[newIdx]=choices[oldIdx];
      }else if(o.approved?.[oldIdx]){
        nextApproved[newIdx]=o.approved[oldIdx];
      }else if(existingItem?.productId){
        nextPinned[newIdx]=existingItem.productId;
      }
      nextLines.push(updatedLine);
    });

    if(!nextLines.length){
      o.audit_trail=[...priorTrail,{at:nowIso(),actor:user_id,text:'All items removed — order cancelled.'}];
      await core('/internal/save',o);
      return res.json(await core('/internal/decision',{id:o.id,user_id,action:'reject',human:true}));
    }

    const keepForceFlag=req.params.action==='substitute'?Boolean(o.force_flag):false;
    const replacement=await plan(nextLines,user_id,keepForceFlag,nextApproved,o.demo_unavailable,o.context||null,nextPinned,null,{
      rawPrompt:o.raw_prompt,
      deliveryDeadline:o.delivery_deadline,
      auditTrail:priorTrail,
      prepareOnly:true

    });
    return res.json(await core('/internal/replace',{id:o.id,user_id,replacement}));
  }
  if(req.params.action==='approve'&&o.incomplete){
    if(!acceptPartial||!o.items.length)throw Error('Select substitutions or accept the available partial order');
    o.incomplete=false;
    o.steps.push('Human accepted partial quantities');
    priorTrail.push({at:nowIso(),actor:user_id,text:'Accepted available partial quantities.'});
  }
  priorTrail.push({
    at:nowIso(),
    actor:user_id,
    text:req.params.action==='approve'?`Approved order (${o.items?.length||0} item${(o.items?.length||0)===1?'':'s'}, €${Number(o.total||0).toFixed(2)}).`:'Cancelled/rejected order.'
  });
  o.audit_trail=priorTrail;
  await core('/internal/save',o);
  res.json(await core('/internal/decision',{id:o.id,user_id,action:req.params.action,human:true}));
});
app.use((e,_req,res,_next)=>{
  const msg=e instanceof z.ZodError?e.issues.map(i=>i.message).join('; '):e.message;
  res.status(e.status||422).json({error:msg||'Request failed',code:e.code||'PORTAL_ERROR'});
});
app.listen(Number(process.env.MIDDLE_LAYER_PORT||4002),'127.0.0.1',()=>console.log('Middle :'+(process.env.MIDDLE_LAYER_PORT||4002)));
