import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {z} from 'zod';
import {DemoStore,demoContents} from './demo-store.js';
export const ruleSchema=z.object({query:z.string().min(1).max(100),minimum:z.number().nonnegative(),target:z.number().positive(),on_hand:z.number().nonnegative(),committed:z.number().nonnegative().default(0),inbound:z.number().nonnegative().default(0),lot:z.number().positive().default(1),max_price:z.number().nonnegative().nullable().default(null),price_quantity:z.number().positive().default(1),currency:z.enum(['EUR','USD','GBP','SEK','NOK','DKK']).default('EUR'),price_unit:z.string().min(1).optional()}).refine(r=>r.target>=r.minimum,'Target must be at least minimum');
export function priceUnitFactor(item,unit){if(unit===item.unit)return 1;const metric={KGM:['kg',1],GRM:['kg',0.001],LTR:['litres',1],MLT:['litres',0.001]}[unit];if(metric){const amount=item.net_contents?.[metric[0]];if(!Number.isFinite(amount)||amount<=0)throw Error(`No verified net ${metric[0]} per sales unit for this product`);return metric[1]/amount;}const base=item.baseUnit;const size=id=>id===base?1:item.units?.find(u=>u.unitId===id)?.sizeInBaseUnits;const sales=size(item.unit),price=size(unit);if(!Number.isFinite(sales)||sales<=0||!Number.isFinite(price)||price<=0)throw Error('No verified conversion for the selected price unit');return price/sales;}
export function enforcePriceCap(items,context){const cap=context?.constraints;if(cap?.max_price==null)return;for(const item of items){const fail=message=>{const error=Error(message);error.code='PRICE_CAP';throw error;};if((item.currency||'EUR')!==(cap.currency||'EUR'))fail('Price cap currency differs from quote currency; no exchange rate configured');if(cap.sales_unit&&item.unit!==cap.sales_unit)fail('Quote unit differs from the configured product sales unit');let factor=cap.price_unit_factor??1;if(['KGM','GRM','LTR','MLT'].includes(cap.price_unit)){try{factor=priceUnitFactor(item,cap.price_unit);}catch(e){fail(e.message);}}const cost=item.price*cap.price_quantity*factor;if(!Number.isFinite(cost)||cost>cap.max_price+1e-9)fail(`Price cap exceeded: ${item.name}; limit ${cap.currency||'EUR'} ${cap.max_price} per ${cap.price_quantity} ${cap.price_unit||'sales units'}`);}}
export function proposal(rule){const position=rule.on_hand-rule.committed+rule.inbound;return {position,quantity:position<rule.minimum?Math.ceil((rule.target-position)/rule.lot)*rule.lot:0};}
// Local demo persistence. A single worker owns this file; uncertain dispatches stay held.
export class ManagedAgent {
 constructor({file,submit,listOrders,now=()=>Date.now()}){this.file=file;this.submit=submit;this.listOrders=listOrders;this.now=now;this.states=Object.create(null);this.queue=Promise.resolve();}
 async load(){try{this.states=Object.assign(Object.create(null),JSON.parse(await readFile(this.file,'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}}
 async save(){await mkdir(dirname(this.file),{recursive:true});await writeFile(this.file+'.tmp',JSON.stringify(this.states),{mode:0o600});await rename(this.file+'.tmp',this.file);}
 serial(fn){const job=this.queue.then(fn);this.queue=job.catch(()=>{});return job;}
 state(user){const s=this.states[user]??={connected:true,enabled:true,provider:'Demo warehouse',location:'Main kitchen',rules:[],activity:[],last_check:null};
 s.connected=true;s.enabled=true;
 if(!s.inventory){s.inventory=new DemoStore().products.map(p=>({id:p.id,name:p.name,unit:p.sales_unit,on_hand:0}));for(const r of s.rules){let item=s.inventory.find(p=>p.name.toLowerCase()===r.query.toLowerCase()||p.id===r.query);if(!item){item={id:randomUUID(),name:r.query,unit:'ST',on_hand:0};s.inventory.push(item);}item.on_hand=r.on_hand;r.product_id=item.id;}}
 for(const item of s.inventory){item.net_contents=demoContents[item.id]||item.net_contents;item.baseUnit??=item.unit;item.units??=[{unitId:item.unit,sizeInBaseUnits:1}];item.allowedLotSize??=1;}
 // Start the demo with one example rule; later saved rules remain available.
 if(user==='demo-buyer'&&!s.initialRuleSetup){
 if(s.rules.length)s.rules=s.rules.slice(0,1);
 else {const item=s.inventory[0];if(item)s.rules.push({...ruleSchema.parse({query:item.name,minimum:10,target:20,on_hand:item.on_hand,price_unit:item.unit}),product_id:item.id,id:randomUUID(),version:1,sales_unit:item.unit,price_unit_factor:1});}
 s.initialRuleSetup=true;
 }
 return s;}
 chat(user,text){const s=this.state(user);const normalized=text.toLowerCase().replace(/atleast/g,'at least');
 const match=/at least\s+(\d+(?:\.\d+)?)\s+(?:units? of\s+)?(.+)/i.exec(normalized);
 if(!match)return {message:'Try specifying a minimum quantity and product, then an optional target and price cap. I will fill the editable form.'};
 const description=match[2];const item=[...s.inventory].sort((a,b)=>b.name.length-a.name.length).find(p=>description===p.name.toLowerCase()||description.startsWith(p.name.toLowerCase()+' ')||description.startsWith(p.name.toLowerCase()+'.')||description.startsWith(p.name.toLowerCase()+','));
 if(!item)return {message:'I could not find that product in your warehouse. Choose a product from the inventory list.'};
 const price=/(?:max(?:imum)?(?:\s+price)?|price\s+(?:cap|limit)|no more than|up to)\s*(?:(?:of|being|is|:|=)\s*)?(?:€\s*)?(\d+(?:[.,]\d+)?)\s*(?:euros?|eur|€)?\s*(?:per|for)\s+(kilograms?|kg|litres?|liters?|litre|liter|l|grams?|g|ml|one|a|an|each|\d+(?:\.\d+)?)(?:\s+([a-z][a-z ]*))?/i.exec(normalized);
 if(/pay|price|euro|€|cost|maximum|max\b/.test(normalized)&&!price)return {message:`For ${item.name}, specify a maximum price and quantity, such as “max price 5 per one”.`};
 const unitCodes={kg:'KGM',kilogram:'KGM',kilograms:'KGM',g:'GRM',gram:'GRM',grams:'GRM',l:'LTR',litre:'LTR',litres:'LTR',liter:'LTR',liters:'LTR',ml:'MLT'};const parsedUnit=price?(unitCodes[price[2]]||unitCodes[price[3]?.trim()]):null;const priceQuantity=price?(unitCodes[price[2]]||/^(one|a|an|each)$/.test(price[2])?1:Number(price[2])):null;
 if(price&&(priceQuantity<=0||(price[3]&&!parsedUnit&&!price[3].startsWith(item.name.toLowerCase())&&!/^(unit|item|piece)s?\b/.test(price[3]))))return {message:`The price cap must refer to a positive quantity of ${item.name}.`};
 const minimum=Number(match[1]);const existing=s.rules.find(r=>r.product_id===item.id);
 const targetMatch=/(?:at most|target(?: of)?|up to)\s+(\d+(?:\.\d+)?)/.exec(normalized.split(/(?:with|and)\s+(?:the\s+)?max(?:imum)?\s+price/)[0]);
 const target=targetMatch?Number(targetMatch[1]):Math.max(existing?.target||minimum*2,minimum,1);
 if(target<minimum||target<=0)return {message:`${item.name}: the target must be positive and at least ${minimum}.`};
 const max_price=price?Number(price[1].replace(',','.')):existing?.max_price??null;
 const price_quantity=priceQuantity??existing?.price_quantity??1;
 return {message:`${item.name}: minimum ${minimum}, ${targetMatch?'target':'suggested target'} ${target}${max_price!=null?`, maximum ${existing?.currency&&existing.currency!=='EUR'?existing.currency+' ':'€'}${max_price} per ${price_quantity} ${parsedUnit||existing?.price_unit||item.unit}`:''}. Form filled — edit and save when ready.`,proposal:{query:item.name,minimum,target,on_hand:item.on_hand,max_price,price_quantity,currency:existing?.currency||'EUR',price_unit:parsedUnit||existing?.price_unit||item.unit}};}

 async command(user,body){return this.serial(async()=>{const s=this.state(user);switch(body.action){
 case 'connect':case 'enable':break;
 case 'rule':{const r=ruleSchema.parse(body.rule);const item=s.inventory.find(p=>p.name.toLowerCase()===r.query.toLowerCase()||p.id===r.query);if(!item)throw Error('Choose a product from the warehouse inventory');r.query=item.name;r.on_hand=item.on_hand;r.price_unit??=item.unit;r.price_unit_factor=priceUnitFactor(item,r.price_unit);r.sales_unit=item.unit;r.lot=item.allowedLotSize;const existing=s.rules.find(x=>x.product_id===item.id);if(existing)Object.assign(existing,r,{version:existing.version+1});else s.rules.push({...r,product_id:item.id,id:randomUUID(),version:1});break;}
 case 'snapshot':{const rule=s.rules.find(r=>r.id===body.id);const item=s.inventory.find(p=>p.id===(rule?.product_id||body.id));if(!item)throw Error('Inventory product not found');item.on_hand=z.number().nonnegative().parse(body.on_hand);for(const r of s.rules.filter(r=>r.product_id===item.id))r.on_hand=item.on_hand;break;}
 default:throw Error('Unknown command');}
 s.activity.push({id:randomUUID(),at:new Date(this.now()).toISOString(),status:'CONFIGURATION',message:body.action});await this.save();return structuredClone(s);});}
 preview(user){return this.state(user).rules.map(r=>({...r,...proposal(r)}));}
 receive(s,r,a){if(a.received)return;const quantity=(a.what||[]).reduce((sum,item)=>sum+item.quantity,0);if(!(quantity>0))return;const item=s.inventory.find(i=>i.id===r.product_id);if(!item)return;item.on_hand+=quantity;r.on_hand=item.on_hand;a.received=true;a.received_at=new Date(this.now()).toISOString();r.episode=null;s.activity.push({id:randomUUID(),at:a.received_at,status:'SIMULATED_RECEIVED',message:`${r.query}: received ${quantity}; on hand ${item.on_hand}`,order_id:a.order_id});}
 async tick(user){return this.serial(async()=>{const s=this.state(user);s.last_check=new Date(this.now()).toISOString();
 const orders=this.listOrders?await this.listOrders(user):[];
 for(const r of s.rules){if(r.episode){const previous=s.activity.find(a=>a.id===r.episode);const order=orders.find(o=>o.id===previous?.order_id);if(order?.status==='APPROVED'){previous.status='SIMULATED_PLACED';previous.what=order.items;}if(previous?.status==='SIMULATED_PLACED')this.receive(s,r,previous);}
 const p=proposal(r);if(r.episode)continue;if(!p.quantity)continue;
 const id=randomUUID();r.episode=id;const context={schema_version:'1.0',action_id:id,agent:{id:'managed:'+user,type:'managed'},why:{trigger:'below_minimum_stock',rule_id:r.id,rule_version:r.version,on_hand:r.on_hand,committed:r.committed,confirmed_inbound:r.inbound,inventory_position:p.position,minimum_stock:r.minimum,target_stock:r.target,quantity:p.quantity,lot:r.lot},confidence:{method:'deterministic_threshold',probability:null,data_quality:'simulated'},evidence:[{source:'demo_customer_warehouse',observed_at:s.last_check}],constraints:{max_price:r.max_price??null,price_quantity:r.price_quantity??1,currency:r.currency||'EUR',price_unit:r.price_unit||r.sales_unit,price_unit_factor:r.price_unit_factor??1,sales_unit:r.sales_unit},purpose:'Restore customer warehouse to configured target'};
 const a={id,at:s.last_check,status:'SUBMITTING',context};s.activity.push(a);await this.save();
 try{const o=await this.submit([{query:r.query,quantity:p.quantity}],user,context,id);a.order_id=o.id;a.status=o.status==='APPROVED'?'SIMULATED_PLACED':o.status;a.what=o.items;if(o.status==='APPROVED')this.receive(s,r,a);a.governance={score:o.score,threshold:o.threshold,reason:o.reason};}catch(e){a.status=e.code==='PRICE_CAP'?'DENIED':'RECONCILING';a.message=e.message;}await this.save();}
 await this.save();});}
}
