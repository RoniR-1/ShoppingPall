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
  const fixtures=[['demo-beer','Lager beer','demo-dark-beer',[]],['demo-dark-beer','Dark beer','demo-beer',[]],['demo-eggs','Eggs',null,[]],['demo-dark-chocolate','Dark chocolate','demo-milk-chocolate',[]],['demo-milk-chocolate','Milk chocolate','demo-dark-chocolate',['milk']],['demo-milk','Milk',null,['milk']],['demo-potato-salad','Potato salad',null,['milk']]];
  this.products=fixtures.map(([id,name,sub,allergens])=>({id,name,allergens,net_contents:demoContents[id],search_text:name.toLowerCase(),sales_unit:'ST',allowed_lot_size:1,carbon_kg_co2_per_kg:null,delivery_reliability:null,raw:{substitutions:sub?[{product:id,substituteProduct:sub}]:[]}}));
  this.orders=new Map();this.reset('normal');
 }
 reset(stock){if(!['normal','low'].includes(stock))throw Error('Unknown stock preset');this.stock=new Map(this.products.map(p=>[p.id,stock==='low'?1:100]));}
 search(q,user='demo-buyer'){q=String(q||'').trim().toLowerCase();if(!q)throw Error('Search required');const history=this.list(user).filter(o=>o.status==='APPROVED');return structuredClone(this.products.filter(p=>p.id===q||p.search_text.includes(q)).map(p=>{const matchingOrders=history.filter(o=>(o.items||[]).some(i=>i.productId===p.id));const prior=matchingOrders.flatMap(o=>(o.items||[]).filter(i=>i.productId===p.id));const quantities=prior.map(i=>Number(i.quantity)).filter(Number.isFinite);return {...p,allergen_safe:!p.allergens.includes('milk'),bought_count:prior.length,human_approved_count:matchingOrders.filter(o=>o.human_approved).length,prior_max_qty:quantities.length?Math.max(...quantities):0,prior_min_qty:quantities.length?Math.min(...quantities):0,prior_avg_qty:quantities.length?quantities.reduce((a,b)=>a+b,0)/quantities.length:0};}));}
 overview(){const row=p=>({...p,quantity:this.stock.get(p.id)});return {mocked:true,products:this.products.map(p=>({...row(p),substitutions:p.raw.substitutions.map(s=>row(this.products.find(p=>p.id===s.substituteProduct)))}))};}
 save(o){const prior=this.orders.get(o.id);if(prior&&(prior.user_id!==o.user_id||prior.status!=='PENDING_APPROVAL'))throw Error('Order cannot be replaced');this.orders.set(o.id,structuredClone(o));return o;}
 list(user){return structuredClone([...this.orders.values()].filter(o=>o.user_id===user));}
 decide({id,user_id,action,human=false}){
  const o=this.orders.get(id);if(!o||o.user_id!==user_id)throw Error('Order not found');
  if(!['approve','reject'].includes(action))throw Error('Invalid action');
  if(o.status!=='PENDING_APPROVAL')return structuredClone(o);
  if(action==='approve'){
   if(o.incomplete||!o.items.length)throw Error('Resolve missing items first');
   const totals=new Map();for(const i of o.items){if(!Number.isFinite(i.quantity)||i.quantity<=0)throw Error('Invalid quantity');totals.set(i.productId,(totals.get(i.productId)||0)+i.quantity);}
   for(const [id,quantity]of totals)if(!this.stock.has(id)||this.stock.get(id)<quantity)throw Error('Stock changed; submit a fresh request');
   for(const [id,quantity]of totals)this.stock.set(id,this.stock.get(id)-quantity);
  }
  o.status=action==='approve'?'APPROVED':'REJECTED';if(action==='approve'&&human)o.human_approved=true;o.steps.push(action==='approve'?'Demo purchase completed · stock updated':'Order rejected');return structuredClone(o);
 }
 live(kind,r){return kind==='price'?{customerId:r.customer,currency:'EUR',pricingDate:r.requestedDate,products:r.products.map(productId=>({productId,quantity:1,netPriceFound:false,error:!this.stock.has(productId),priceWithTax:{value:2.5,currency:'EUR',validFrom:r.requestedDate,validTo:r.requestedDate}}))}:{timeNow:new Date().toISOString(),requestedDate:r.requestedDate,products:r.products.map(productId=>({productId,salesBlock:false,logisticModel:'Stock',closingTime:null,scheduleLines:[{availableAmount:this.stock.get(productId)||0,availableDate:r.requestedDate,salesUnit:'ST',salesBlock:false}]}))};}
}
