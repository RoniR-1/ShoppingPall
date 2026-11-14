// Explicit synthetic net contents per demo sales unit, not Valio product facts.
export const demoContents={
 'demo-beer':{litres:0.33},'demo-dark-beer':{litres:0.33},
 'demo-eggs':{kg:0.06},'demo-dark-chocolate':{kg:0.1},
 'demo-milk-chocolate':{kg:0.1},'demo-milk':{litres:1},
 'demo-potato-salad':{kg:0.4}
};
// Entirely local, process-memory demo. No credentials or database connection.
export class DemoStore {
 constructor(){
  const fixtures=[['demo-beer','Lager beer','demo-dark-beer'],['demo-dark-beer','Dark beer','demo-beer'],['demo-eggs','Eggs',null],['demo-dark-chocolate','Dark chocolate','demo-milk-chocolate'],['demo-milk-chocolate','Milk chocolate','demo-dark-chocolate'],['demo-milk','Milk',null],['demo-potato-salad','Potato salad',null]];
  this.products=fixtures.map(([id,name,sub])=>({id,name,net_contents:demoContents[id],search_text:name.toLowerCase(),sales_unit:'ST',allowed_lot_size:1,carbon_kg_co2_per_kg:null,delivery_reliability:null,raw:{substitutions:sub?[{product:id,substituteProduct:sub}]:[]}}));
  this.orders=new Map();this.buyers=new Map([['demo-buyer',this.#normThreshold(process.env.SUSPICION_THRESHOLD??25)]]);this.reset('normal');
 }
 #normThreshold(v){const n=Number(v);if(!Number.isFinite(n)||n<0)throw Error('Invalid threshold');return Math.round(n*1000)/1000;}
 #normUser(u){const id=String(u||'').trim();if(!id)throw Error('Buyer ID required');return id;}
 listBuyers(defaultThreshold=process.env.SUSPICION_THRESHOLD??25){
  const def=this.#normThreshold(defaultThreshold);
  for(const o of this.orders.values())if(o.user_id&&!this.buyers.has(o.user_id))this.buyers.set(o.user_id,def);
  return [...this.buyers.entries()].map(([user_id,threshold])=>({user_id,threshold}));
 }
 getBuyer(userId,defaultThreshold=process.env.SUSPICION_THRESHOLD??25){
  const id=this.#normUser(userId);
  if(!this.buyers.has(id))this.buyers.set(id,this.#normThreshold(defaultThreshold));
  return {user_id:id,threshold:this.buyers.get(id)};
 }
 upsertBuyer(userId,threshold,{createOnly=false}={}){
  const id=this.#normUser(userId);
  if(createOnly&&this.buyers.has(id))throw Error(`Buyer "${id}" already exists`);
  const t=this.#normThreshold(threshold);
  this.buyers.set(id,t);
  return {user_id:id,threshold:t};
 }
 reset(stock){if(!['normal','low'].includes(stock))throw Error('Unknown stock preset');this.stock=new Map(this.products.map(p=>[p.id,stock==='low'?1:100]));}
 search(q){q=String(q||'').trim().toLowerCase();if(!q)throw Error('Search required');return structuredClone(this.products.filter(p=>p.id===q||p.search_text.includes(q)));}
 overview(){const row=p=>({...p,quantity:this.stock.get(p.id)});return {mocked:true,products:this.products.map(p=>({...row(p),substitutions:p.raw.substitutions.map(s=>row(this.products.find(p=>p.id===s.substituteProduct)))}))};}
 save(o){const prior=this.orders.get(o.id);if(prior&&(prior.user_id!==o.user_id||prior.status!=='PENDING_APPROVAL'))throw Error('Order cannot be replaced');if(o.user_id&&!this.buyers.has(o.user_id))this.buyers.set(o.user_id,this.#normThreshold(process.env.SUSPICION_THRESHOLD??25));this.orders.set(o.id,structuredClone(o));return o;}
 list(user){return structuredClone([...this.orders.values()].filter(o=>o.user_id===user));}
 decide({id,user_id,action}){
  const o=this.orders.get(id);if(!o||o.user_id!==user_id)throw Error('Order not found');
  if(!['approve','reject'].includes(action))throw Error('Invalid action');
  if(o.status!=='PENDING_APPROVAL')return structuredClone(o);
  if(action==='approve'){
   if(o.incomplete||!o.items.length)throw Error('Resolve missing items first');
   const totals=new Map();for(const i of o.items){if(!Number.isFinite(i.quantity)||i.quantity<=0)throw Error('Invalid quantity');totals.set(i.productId,(totals.get(i.productId)||0)+i.quantity);}
   for(const [id,quantity]of totals)if(!this.stock.has(id)||this.stock.get(id)<quantity)throw Error('Stock changed; submit a fresh request');
   for(const [id,quantity]of totals)this.stock.set(id,this.stock.get(id)-quantity);
  }
  o.status=action==='approve'?'APPROVED':'REJECTED';o.steps.push(action==='approve'?'Demo purchase completed · stock updated':'Order rejected');return structuredClone(o);
 }
 live(kind,r){return kind==='price'?{customerId:r.customer,currency:'EUR',pricingDate:r.requestedDate,products:r.products.map(productId=>({productId,quantity:1,netPriceFound:false,error:!this.stock.has(productId),priceWithTax:{value:2.5,currency:'EUR',validFrom:r.requestedDate,validTo:r.requestedDate}}))}:{timeNow:new Date().toISOString(),requestedDate:r.requestedDate,products:r.products.map(productId=>({productId,salesBlock:false,logisticModel:'Stock',closingTime:null,scheduleLines:[{availableAmount:this.stock.get(productId)||0,availableDate:r.requestedDate,salesUnit:'ST',salesBlock:false}]}))};}
}
