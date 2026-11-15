import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {RealInventorySimulation} from '../src/web-demo/real-inventory-simulation.js';
const catalog=[
 {id:'a',name:'Database apples',sales_unit:'ST',base_unit:'ST',allowed_lot_size:1,quantity:20,units:[{unitId:'ST',sizeInBaseUnits:1}],substitutions:[{product:'a',substituteProduct:'b'}]},
 {id:'b',name:'Database apple substitute',sales_unit:'ST',base_unit:'ST',allowed_lot_size:1,quantity:20,units:[{unitId:'ST',sizeInBaseUnits:1}],substitutions:[]}
];
async function setup(t){const dir=await mkdtemp(tmpdir()+'/real-inventory-');t.after(()=>rm(dir,{recursive:true,force:true}));let now=100000;const args={file:dir+'/state.json',catalog:async()=>catalog,now:()=>now};const agent=new RealInventorySimulation(args);await agent.initialize('buyer');return {agent,args,advance:n=>{now+=n;}};}
test('database simulation persists partial shipments and receives backorder later',async t=>{const {agent,args,advance}=await setup(t);await agent.command('buyer',{action:'simulation',scenario:'partial'});await agent.command('buyer',{action:'snapshot',id:'a',on_hand:2});let s=agent.snapshot('buyer'),o=s.orders[0];assert.equal(o.scenario,'partial');assert.ok(o.remainder>0);assert.equal(o.shipments[0].status,'IN_TRANSIT');assert.equal(o.shipments[1].status,'BACKORDERED');advance(12000);await agent.tick('buyer');s=agent.snapshot('buyer');assert.equal(s.orders[0].shipments[0].status,'RECEIVED');assert.equal(s.orders[0].shipments[1].status,'BACKORDERED');const b=new RealInventorySimulation(args);await b.load();advance(4000);await b.tick('buyer');assert.equal(b.snapshot('buyer').orders[0].shipments[1].status,'IN_TRANSIT');advance(8000);await b.tick('buyer');s=b.snapshot('buyer');assert.equal(s.orders[0].shipments[1].status,'RECEIVED');assert.equal(s.orders[0].remainder,0);assert.equal(s.inventory.find(i=>i.id==='a').on_hand,20);});
test('substitute requires approval and credits actual SKU without repeated original orders',async t=>{const {agent,advance}=await setup(t);await agent.command('buyer',{action:'simulation',scenario:'substitution'});await agent.command('buyer',{action:'snapshot',id:'a',on_hand:2});let s=agent.snapshot('buyer'),o=s.orders[0];assert.equal(o.status,'PENDING_APPROVAL');assert.equal(o.items[0].productId,'b');await agent.command('buyer',{action:'decision',id:o.id,decision:'approve'});advance(12000);await agent.tick('buyer');s=agent.snapshot('buyer');assert.equal(s.inventory.find(i=>i.id==='a').on_hand,2);assert.equal(s.inventory.find(i=>i.id==='b').on_hand,38);assert.equal(s.orders.length,1);assert.equal(s.activity.find(a=>a.id===o.id).status,'SUBSTITUTED');const events=s.telemetry.length;await agent.tick('buyer');assert.equal(agent.snapshot('buyer').telemetry.length,events);});
test('price cap exceptions require review and malformed caps are rejected',async t=>{const {agent}=await setup(t);await assert.rejects(agent.command('buyer',{action:'rule',rule:{query:'Database apples',minimum:10,target:20,price_quantity:0,max_price:1,currency:'EUR'}}));await agent.command('buyer',{action:'rule',rule:{query:'Database apples',minimum:10,target:20,price_quantity:1,max_price:1,currency:'EUR'}});await agent.command('buyer',{action:'snapshot',id:'a',on_hand:2});const order=agent.snapshot('buyer').orders[0];assert.equal(order.status,'PENDING_APPROVAL');assert.match(order.policy_breach,/Price cap exceeded/);});
test('empty database fails without loading demo products',async t=>{const {args}=await setup(t);const agent=new RealInventorySimulation({...args,file:args.file+'-empty',catalog:async()=>[]});await assert.rejects(agent.initialize('buyer'),/No eligible products/);});
test('substitution spike selects an eligible product even when others lack substitutes',async t=>{const {agent}=await setup(t);await agent.command('buyer',{action:'simulation',scenario:'substitution'});await agent.command('buyer',{action:'demand_spike'});const s=agent.snapshot('buyer');assert.equal(s.orders.length,1);assert.equal(s.orders[0].requested_product_name,'Database apples');assert.equal(s.orders[0].items[0].productId,'b');assert.equal(s.orders[0].status,'PENDING_APPROVAL');});
test('automatic demo batches lead to real simulated replenishment activity',async t=>{
 const {agent,advance}=await setup(t);
 await agent.command('buyer',{action:'simulation',running:true,speed:'6x',scenario:'full'});
 for(let i=0;i<9;i++){advance(1333);await agent.simulationStep('buyer');}
 let s=agent.snapshot('buyer');
 assert.ok(s.orders.length>0);
 for(const category of ['CONSUMPTION','THRESHOLD','POLICY','ORDER'])assert.ok(s.telemetry.some(e=>e.category===category),category);
 assert.ok(s.telemetry.some(e=>e.category==='CONSUMPTION'&&/Wholesale order|Large production batch|Catering order/.test(e.message)));
 assert.ok(s.telemetry.some(e=>e.category==='CONSUMPTION'&&/Kitchen service|Breakfast service|Order preparation|Production run/.test(e.message)));
 assert.ok(s.inventory.every(i=>i.on_hand>=0&&Number.isInteger(i.on_hand)));
 await agent.command('buyer',{action:'simulation',running:false});
 advance(5000);await agent.simulationStep('buyer');s=agent.snapshot('buyer');
 assert.ok(s.telemetry.some(e=>e.category==='RESTOCK'));
 assert.ok(s.orders.some(o=>o.shipments.some(sh=>sh.status==='RECEIVED')));
});
test('automatic demand does not consume stock held for an approval episode',async t=>{
 const {agent,advance}=await setup(t);
 await agent.command('buyer',{action:'simulation',running:true,speed:'6x',scenario:'full',governance:'human'});
 await agent.command('buyer',{action:'snapshot',id:'a',on_hand:2});
 assert.equal(agent.snapshot('buyer').orders[0].status,'PENDING_APPROVAL');
 for(let i=0;i<9;i++){advance(1333);await agent.simulationStep('buyer');}
 assert.equal(agent.snapshot('buyer').inventory.find(i=>i.id==='a').on_hand,2);
});
test('approval queue keeps five oldest requests and rejects overflow until a slot opens',async t=>{
 const {args}=await setup(t);
 const products=Array.from({length:7},(_,i)=>({id:String(i),name:`Product ${i}`,sales_unit:'ST',base_unit:'ST',allowed_lot_size:1,quantity:20,units:[{unitId:'ST',sizeInBaseUnits:1}],substitutions:[]}));
 const agent=new RealInventorySimulation({...args,file:args.file+'-cap',catalog:async()=>products});await agent.initialize('buyer');
 await agent.command('buyer',{action:'simulation',governance:'human',scenario:'full'});
 for(let i=0;i<6;i++)await agent.command('buyer',{action:'snapshot',id:String(i),on_hand:2});
 let s=agent.snapshot('buyer');assert.deepEqual(s.orders.map(o=>o.status),['PENDING_APPROVAL','PENDING_APPROVAL','PENDING_APPROVAL','PENDING_APPROVAL','PENDING_APPROVAL','REJECTED']);
 const rejected=s.orders[5];assert.match(rejected.reason,/queue is full/);assert.equal(rejected.shipments[0].status,'REJECTED');
 assert.match(s.activity.find(a=>a.id===rejected.id).message,/queue is full/);
 assert.ok(s.telemetry.some(e=>e.message.includes('queue is full')));
 await agent.tick('buyer');assert.match(agent.snapshot('buyer').activity.find(a=>a.id===rejected.id).message,/queue is full/);
 await agent.command('buyer',{action:'decision',id:s.orders[0].id,decision:'reject'});
 await agent.command('buyer',{action:'snapshot',id:'6',on_hand:2});s=agent.snapshot('buyer');
 assert.equal(s.orders.filter(o=>o.status==='PENDING_APPROVAL').length,5);assert.equal(s.orders[6].status,'PENDING_APPROVAL');
});
test('initialization rejects previously stored overflow, preserving oldest approvals',async t=>{
 const {agent,args}=await setup(t);const s=agent.states.buyer;
 s.orders=Array.from({length:7},(_,i)=>({id:String(i),status:'PENDING_APPROVAL',requested_product_name:`Product ${i}`,context:{agent:{type:'managed'}},shipments:[{status:'PENDING_APPROVAL'}]}));
 s.activity=s.orders.map((o,i)=>({id:o.id,status:'PENDING_APPROVAL',at:new Date(100000+i*1000).toISOString()}));
 s.orders.reverse();await agent.save();const restarted=new RealInventorySimulation(args);await restarted.load();await restarted.initialize('buyer');
 const result=restarted.snapshot('buyer');assert.deepEqual(result.orders.filter(o=>o.status==='PENDING_APPROVAL').map(o=>o.id).sort(),['0','1','2','3','4']);
 assert.match(result.activity.find(a=>a.id==='5').message,/queue is full/);
});
