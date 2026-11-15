import {randomUUID} from 'node:crypto';
import {ManagedAgent,enforcePriceCap,proposal,ruleSchema,priceUnitFactor} from './managed-agent.js';

const interval = speed => speed === '6x' ? 1333 : speed === 'fast' ? 3000 : 8000;
const delay = (speed, multiplier = 1) => Math.round((speed === '6x' ? 5000 : speed === 'fast' ? 8000 : 12000) * multiplier);
const compatible = (a,b) => { const size = p => (p.units || []).find(u => u.unitId === p.unit)?.sizeInBaseUnits; return Boolean(a.baseUnit && b.baseUnit && a.baseUnit === b.baseUnit && a.unit === b.unit && Number.isFinite(Number(size(a))) && Number(size(a)) > 0 && Number(size(a)) === Number(size(b))); };
const number = n => Number.isFinite(Number(n)) ? Number(n) : 0;
const APPROVAL_LIMIT = 5;

// This engine persists simulated warehouse state and orders separately from the
// supplier database. Only the catalog snapshot is read from PostgreSQL.
export class RealInventorySimulation extends ManagedAgent {
 constructor({file,catalog,now=()=>Date.now()}) { super({file,now}); this.catalog=catalog; }
 state(user){const state=this.states[user];if(!state)throw Error('Database simulation not initialized');return state;}
 enforceApprovalLimit(s){
  const pending=s.orders.filter(o=>o.status==='PENDING_APPROVAL'&&o.context?.agent?.type==='managed').sort((a,b)=>{
   const time=o=>Date.parse(o.created_at||s.activity.find(entry=>entry.id===o.id)?.at)||0;
   return time(a)-time(b);
  });
  for(const o of pending.slice(APPROVAL_LIMIT)){
   o.status='REJECTED';o.reason='Automatically rejected: approval queue is full (maximum 5).';
   for(const shipment of o.shipments||[])if(shipment.status==='PENDING_APPROVAL')shipment.status='REJECTED';
   const activity=s.activity.find(a=>a.id===o.id);if(activity){activity.status='REJECTED';activity.message=o.reason;}
   this.telemetry(s,'ORDER',`${o.requested_product_name}: ${o.reason}`);
  }
  return pending.length>APPROVAL_LIMIT;
 }
 consumeBatch(s){
  // Simulate whole service or production batches, scaled to each warehouse's
  // configured stock range. Focus on the closest reorder points so a short
  // demonstration includes the resulting order and delivery workflow.
  const candidates=s.rules.filter(r=>!r.episode&&r.minimum>0&&s.inventory.some(i=>i.id===r.product_id&&i.on_hand>0))
   .sort((a,b)=>(a.on_hand-a.minimum)/Math.max(1,a.target-a.minimum)-(b.on_hand-b.minimum)/Math.max(1,b.target-b.minimum)).slice(0,2);
  if(!candidates.length)return;
  const r=candidates[Math.floor(Math.random()*candidates.length)],item=s.inventory.find(i=>i.id===r.product_id),before=item.on_hand;
  const amount=Math.max(1,Math.round(Math.max(1,r.target-r.minimum)*(.35+Math.random()*.3)));
  item.on_hand=Math.max(0,before-amount);r.on_hand=item.on_hand;
  const reasons=['Wholesale order','Large production batch','Catering order'][Math.floor(Math.random()*3)];
  this.telemetry(s,'CONSUMPTION',`-${Math.round((before-item.on_hand)*100)/100} ${item.name} (${reasons}) | Stock: ${item.on_hand}/${r.target}`);
  if(item.on_hand<r.minimum)this.telemetry(s,'THRESHOLD',`${item.name} below minimum ${r.minimum}; evaluating replenishment`);
 }
 consume(s,spike=false){
  if(spike&&s.simulation.scenario==='substitution'){
   const candidates=s.rules.filter(r=>!r.episode&&r.minimum>0).filter(r=>{
    const item=s.inventory.find(i=>i.id===r.product_id);if(!item)return false;
    const after=Math.min(item.on_hand,Math.max(0,Math.ceil(r.minimum)-1));
    const qty=proposal({...r,on_hand:after}).quantity;
    return qty>0&&(item.substitutions||[]).some(x=>String(x.product)===item.id&&s.inventory.some(alt=>alt.id===String(x.substituteProduct)&&compatible(item,alt)&&Math.abs(qty/alt.allowedLotSize-Math.round(qty/alt.allowedLotSize))<1e-8));
   });
   if(candidates.length){const r=candidates[Math.floor(Math.random()*candidates.length)],item=s.inventory.find(i=>i.id===r.product_id),before=item.on_hand;item.on_hand=Math.min(before,Math.max(0,Math.ceil(r.minimum)-1));r.on_hand=item.on_hand;this.telemetry(s,'CONSUMPTION',`-${before-item.on_hand} ${item.name} (Demand spike) | Stock: ${item.on_hand}/${r.target}`);this.telemetry(s,'THRESHOLD',`${item.name} below minimum ${r.minimum}; evaluating replenishment`);return;}
  }
  return super.consume(s,spike);
 }
 async initialize(user) {
  await this.serial(async()=>{
   if(this.states[user]?.catalog_source==='database'){if(this.enforceApprovalLimit(this.states[user]))await this.save();return;}
   const products=await this.catalog(user);
   if(!Array.isArray(products)||!products.length)throw Object.assign(Error('No eligible products found in the database. Check the catalog and buyer policy.'),{status:503});
   const eligible=products.filter(p=>p.id&&p.name&&p.sales_unit&&number(p.allowed_lot_size)>0&&number(p.quantity)>0);
   if(!eligible.length)throw Object.assign(Error('No eligible in-stock products found in the database.'),{status:503});
   const byId=new Map(eligible.map(p=>[String(p.id),p]));
   const equivalent=(a,b)=>compatible({unit:a.sales_unit,baseUnit:a.base_unit,units:a.units},{unit:b.sales_unit,baseUnit:b.base_unit,units:b.units})&&number(a.allowed_lot_size)===number(b.allowed_lot_size);
   const hasAlt=p=>(Array.isArray(p.substitutions)?p.substitutions:[]).some(x=>String(x.product)===String(p.id)&&byId.has(String(x.substituteProduct))&&equivalent(p,byId.get(String(x.substituteProduct))));
   const chosen=[...eligible.filter(hasAlt),...eligible.filter(p=>!hasAlt(p))].slice(0,8);
   const ids=new Set(chosen.map(p=>String(p.id)));
   for(const p of [...chosen])for(const sub of Array.isArray(p.substitutions)?p.substitutions:[]){const candidate=byId.get(String(sub.substituteProduct));if(chosen.length<12&&String(sub.product)===String(p.id)&&candidate&&equivalent(p,candidate)&&!ids.has(String(candidate.id))){chosen.push(candidate);ids.add(String(candidate.id));break;}}
   const inventory=chosen.map(p=>({id:String(p.id),name:p.name,unit:p.sales_unit,baseUnit:p.base_unit,units:Array.isArray(p.units)?p.units:[],allowedLotSize:number(p.allowed_lot_size),on_hand:number(p.quantity),database_stock:number(p.quantity),substitutions:Array.isArray(p.substitutions)?p.substitutions:[]}));
   const rules=inventory.map(p=>{const lot=p.allowedLotSize;const minimum=Math.max(lot,Math.floor((p.on_hand*.5)/lot)*lot);const target=Math.max(minimum,Math.ceil(Math.max(p.on_hand,lot*2)/lot)*lot);return {id:randomUUID(),version:1,query:p.name,product_id:p.id,minimum,target,on_hand:p.on_hand,committed:0,inbound:0,lot,max_price:null,price_quantity:1,currency:'EUR',price_unit:p.unit,sales_unit:p.unit,price_unit_factor:1};});
   this.states[user]={catalog_source:'database',provider:'Database catalog',location:'Simulated warehouse',connected:true,enabled:true,inventory,rules,orders:[],activity:[],telemetry:[],metrics:{stockouts_prevented:0,autonomous_orders:0,spend_governed:0},simulation:{running:false,speed:'1x',governance:'autonomous',scenario:'mixed',next_consumption:null,scenario_index:0}};
   this.telemetry(this.states[user],'POLICY','Database catalog loaded. Stock movements, quotes, orders and arrival times are simulated.');
   await this.save();
  });
 }
 snapshot(user){const s=this.states[user];return {...structuredClone(s),preview:s.rules.map(r=>({...r,...proposal(r)})),simulated:true};}
 async command(user,body){
  if(body.action==='check'){await this.tick(user);return this.snapshot(user);}
  if(body.action==='decision'){await this.decide(user,body.id,body.decision);return this.snapshot(user);}
  await this.serial(async()=>{
   const s=this.states[user];if(!s)throw Error('Database simulation not initialized');
   if(body.action==='simulation'){
    const sim=s.simulation;
    if(body.running!==undefined){if(typeof body.running!=='boolean')throw Error('Invalid simulation state');sim.running=body.running;}
    if(body.speed!==undefined){if(!['1x','fast','6x'].includes(body.speed))throw Error('Invalid speed');sim.speed=body.speed;}
    if(body.governance!==undefined){if(!['autonomous','human'].includes(body.governance))throw Error('Invalid governance');sim.governance=body.governance;}
    if(body.scenario!==undefined){if(!['mixed','full','partial','substitution'].includes(body.scenario))throw Error('Invalid scenario');sim.scenario=body.scenario;}
    sim.next_consumption=sim.running?this.now()+interval(sim.speed):null;
   }else if(['consume','demand_spike'].includes(body.action))this.consume(s,body.action==='demand_spike');
   else if(body.action==='snapshot'){
    const item=s.inventory.find(p=>p.id===body.id);if(!item||!Number.isFinite(body.on_hand)||body.on_hand<0)throw Error('Invalid stock quantity');item.on_hand=body.on_hand;const rule=s.rules.find(r=>r.product_id===item.id);if(rule)rule.on_hand=item.on_hand;
   }else if(body.action==='rule'){
    const input=body.rule||{},item=s.inventory.find(p=>p.name===input.query||p.id===input.query),r=s.rules.find(x=>x.product_id===item?.id);
    if(!r)throw Error('Product not found');const parsed=ruleSchema.parse({...input,on_hand:item.on_hand,lot:item.allowedLotSize});parsed.price_unit??=item.unit;const factor=priceUnitFactor(item,parsed.price_unit);Object.assign(r,parsed,{product_id:item.id,sales_unit:item.unit,price_unit_factor:factor,version:r.version+1});
   }else if(body.action==='reset_episode'){
    const a=s.activity.find(a=>a.id===body.id),r=s.rules.find(r=>r.episode===body.id);if(!a||!r||!['DENIED','REJECTED','SUBSTITUTED'].includes(a.status))throw Error('No blocked episode to retry');a.resolved_at=new Date(this.now()).toISOString();r.episode=null;
   }else throw Error('Unknown command');
   await this.save();
  });
  await this.tick(user);return this.snapshot(user);
 }
 async decide(user,id,decision){await this.serial(async()=>{const s=this.states[user],o=s.orders.find(o=>o.id===id);if(!o||o.status!=='PENDING_APPROVAL'||!['approve','reject'].includes(decision))throw Error('Order is no longer pending');o.status=decision==='approve'?'APPROVED':'REJECTED';const r=s.rules.find(r=>r.episode===o.id);if(o.status==='APPROVED'){this.dispatch(s,o);if(r){const a=s.activity.find(a=>a.id===o.id);a.status='SIMULATED_PLACED';}}else if(r){const a=s.activity.find(a=>a.id===o.id);a.status='REJECTED';a.message='Order rejected';}await this.save();});}
 dispatch(s,o){const now=this.now();o.shipments.forEach((sh,i)=>{sh.eta=new Date(now+delay(s.simulation.speed,i?2:1)).toISOString();sh.status=sh.backorder?'BACKORDERED':'IN_TRANSIT';if(sh.backorder)sh.release_at=new Date(now+delay(s.simulation.speed,1.25)).toISOString();});s.metrics.autonomous_orders++;this.telemetry(s,'ORDER',`${o.requested_product_name}: ${o.items.reduce((n,x)=>n+x.quantity,0)} ordered; first arrival ${new Date(o.shipments[0].eta).toLocaleTimeString('en-GB')}`);}
 async simulationStep(user){await this.serial(async()=>{const s=this.states[user];if(!s)return;const sim=s.simulation;if(sim.running&&this.now()>=sim.next_consumption){sim.demand_index=(sim.demand_index||0)+1;if(sim.demand_index%3===0)this.consume(s);else this.consumeBatch(s);const next=sim.next_consumption+interval(sim.speed);sim.next_consumption=next>this.now()?next:this.now()+interval(sim.speed);await this.save();}});await this.tick(user);}
 async tick(user){return this.serial(async()=>{const s=this.states[user];if(!s)return;const before=JSON.stringify(s);
  this.enforceApprovalLimit(s);
  for(const o of s.orders.filter(o=>o.status==='APPROVED'))for(const sh of o.shipments.filter(sh=>sh.status==='BACKORDERED'&&Date.parse(sh.release_at)<=this.now())){sh.status='IN_TRANSIT';this.telemetry(s,'ORDER',`${sh.name}: backorder dispatched`);}
  for(const o of s.orders.filter(o=>o.status==='APPROVED'))for(const sh of o.shipments.filter(sh=>sh.status==='IN_TRANSIT'&&Date.parse(sh.eta)<=this.now())){const item=s.inventory.find(p=>p.id===sh.product_id);if(item){item.on_hand+=sh.quantity;const rule=s.rules.find(r=>r.product_id===item.id);if(rule)rule.on_hand=item.on_hand;}sh.status='RECEIVED';if(sh.backorder)o.remainder=Math.max(0,o.remainder-sh.quantity);sh.received_at=new Date(this.now()).toISOString();this.telemetry(s,'RESTOCK',`${sh.name}: received ${sh.quantity}${sh.substitution?' (substitute)':''}`);}
  for(const r of s.rules){
   if(r.episode){const order=s.orders.find(o=>o.id===r.episode);if(order?.status==='APPROVED'&&order.shipments.every(sh=>sh.status==='RECEIVED')){const a=s.activity.find(a=>a.id===r.episode);if(order.shipments.some(sh=>sh.substitution)){if(a.status!=='SUBSTITUTED'){a.status='SUBSTITUTED';a.message=`Fulfilled with ${order.shipments.filter(sh=>sh.substitution).map(sh=>sh.name).join(', ')}; original SKU unchanged. Review original stock before retrying.`;this.telemetry(s,'RESTOCK',a.message);}continue;}else{a.status='SIMULATED_RECEIVED';r.episode=null;if(r.on_hand>=r.minimum)s.metrics.stockouts_prevented++;}}else continue;}
   const p=proposal(r);if(!p.quantity)continue;
   const item=s.inventory.find(x=>x.id===r.product_id),id=randomUUID();r.episode=id;
   const context={agent:{type:'managed'},why:{rule_id:r.id,product_id:item.id,quantity:p.quantity},constraints:{max_price:r.max_price,price_quantity:r.price_quantity,currency:r.currency,price_unit:r.price_unit,sales_unit:r.sales_unit,price_unit_factor:r.price_unit_factor}};
   const activity={id,at:new Date(this.now()).toISOString(),status:'SUBMITTING',context};s.activity.push(activity);
   let scenario=s.simulation.scenario;if(scenario==='mixed'){scenario=['full','partial','substitution'][s.simulation.scenario_index++%3];}
   const alternative=(item.substitutions||[]).filter(x=>String(x.product)===item.id).map(x=>s.inventory.find(i=>i.id===String(x.substituteProduct)&&compatible(item,i)&&Math.abs(p.quantity/i.allowedLotSize-Math.round(p.quantity/i.allowedLotSize))<1e-8)).find(Boolean);
   if(scenario==='substitution'&&!alternative){this.telemetry(s,'POLICY',`${item.name}: no verified compatible substitution available; simulating a partial order instead`);scenario='partial';}
   const substitute=scenario==='substitution'?alternative:null,lot=item.allowedLotSize;
   let first=scenario==='partial'?Math.max(lot,Math.floor((p.quantity/2)/lot)*lot):p.quantity;first=Math.min(first,p.quantity);
   const lines=[{productId:(substitute||item).id,name:(substitute||item).name,unit:(substitute||item).unit,quantity:first,price:2.5,currency:'EUR',substitution:Boolean(substitute)}];
   if(first<p.quantity)lines.push({productId:item.id,name:item.name,unit:item.unit,quantity:p.quantity-first,price:2.5,currency:'EUR',backorder:true});
   let policyBreach=null;try{enforcePriceCap(lines,context);}catch(e){policyBreach=e.message;this.telemetry(s,'POLICY',policyBreach);}
   const manual=s.simulation.governance==='human'||Boolean(substitute)||Boolean(policyBreach);
   const o={id,requested_product_name:item.name,requested_quantity:p.quantity,context,items:lines,total:lines.reduce((n,l)=>n+l.quantity*l.price,0),status:manual?'PENDING_APPROVAL':'APPROVED',reason:policyBreach|| (substitute?'Substitution requires review':manual?'Human-in-the-loop review required':'Price cap validated'),policy_breach:policyBreach,incomplete:false,simulated:true,scenario,remainder:p.quantity-first,shipments:lines.map(l=>({product_id:l.productId,name:l.name,quantity:l.quantity,substitution:l.substitution||false,backorder:l.backorder||false,status:manual?'PENDING_APPROVAL':'IN_TRANSIT',eta:null}))};
   s.orders.push(o);activity.status=manual?'PENDING_APPROVAL':'SIMULATED_PLACED';activity.order_id=id;activity.what=lines;s.metrics.spend_governed+=o.total;if(!policyBreach)this.telemetry(s,'POLICY',`${item.name}: simulated quote validated against price cap`);if(manual){this.enforceApprovalLimit(s);if(o.status==='PENDING_APPROVAL')this.telemetry(s,'ORDER',`${item.name}: ${substitute?'substitution':'order'} awaiting approval`);}else this.dispatch(s,o);
  }
  if(JSON.stringify(s)!==before)await this.save();
 });}
}
