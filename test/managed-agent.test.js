import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {ManagedAgent,proposal,ruleSchema} from '../src/web-demo/managed-agent.js';
import {route} from '../src/web-demo/policy.js';
test('rounds stock deficit to lots and includes inbound',()=>{assert.deepEqual(proposal({on_hand:8,committed:2,inbound:0,minimum:10,target:30,lot:6}),{position:6,quantity:24});assert.equal(proposal({on_hand:8,committed:2,inbound:10,minimum:10,target:30,lot:6}).quantity,0);assert.equal(ruleSchema.safeParse({query:'milk',minimum:20,target:10,on_hand:0}).success,false);});
test('agent provenance does not affect shared screening',()=>{const o={lines:[{quantity:150}],incomplete:false};assert.deepEqual(route({...o,agent_type:'managed'}),route({...o,agent_type:'custom'}));});
test('automatic monitoring and restart suppress duplicate episodes',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-');try{let calls=0;const args={file:dir+'/state.json',submit:async()=>{calls++;return {id:'order',status:'APPROVED',items:[]};}};const a=new ManagedAgent(args);await a.load();await a.command('buyer',{action:'rule',rule:{query:'milk',minimum:10,target:20,on_hand:5}});await Promise.all([a.tick('buyer'),a.tick('buyer')]);assert.equal(calls,1);const b=new ManagedAgent(args);await b.load();await b.tick('buyer');assert.equal(calls,1);await b.tick('buyer');assert.equal(calls,1);assert.equal(b.state('buyer').activity.find(x=>x.context).status,'SIMULATED_PLACED');}finally{await rm(dir,{recursive:true,force:true});}});
test('all warehouse products can be edited without rules and chat updates existing rules',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-inventory-');try{const a=new ManagedAgent({file:dir+'/state.json',submit:async()=>{}});await a.load();assert.equal(a.state('buyer').inventory.length,7);await a.command('buyer',{action:'snapshot',id:'demo-eggs',on_hand:12});assert.equal(a.state('buyer').inventory.find(p=>p.id==='demo-eggs').on_hand,12);const chat=a.chat('buyer','Keep at least 5 eggs');assert.equal(chat.proposal.on_hand,12);await a.command('buyer',{action:'rule',rule:chat.proposal});await a.command('buyer',{action:'rule',rule:{...chat.proposal,minimum:8,target:16}});assert.equal(a.state('buyer').rules.length,1);assert.equal(a.preview('buyer')[0].position,12);await a.command('buyer',{action:'snapshot',id:'demo-eggs',on_hand:2});assert.equal(a.preview('buyer')[0].quantity,14);assert.match(a.chat('buyer','hello').message,/Try/);assert.match(a.chat('buyer','keep at least 5 unicorns').message,/could not find/);const b=new ManagedAgent({file:dir+'/state.json'});await b.load();assert.equal(b.state('buyer').inventory.find(p=>p.id==='demo-eggs').on_hand,2);}finally{await rm(dir,{recursive:true,force:true});}});
test('free-form stock instruction fills an editable price-capped rule',async()=>{const {enforcePriceCap}=await import('../src/web-demo/managed-agent.js');const a=new ManagedAgent({file:'/unused'});const result=a.chat('buyer','i wnt atleast 10 eggs at all time and would only pay a maximum of 2 euro per 10 eggs');assert.deepEqual(result.proposal,{query:'Eggs',minimum:10,target:20,on_hand:0,max_price:2,price_quantity:10,currency:'EUR',price_unit:'ST'});const rule=ruleSchema.parse(result.proposal);assert.equal(rule.max_price,2);const context={constraints:rule};assert.throws(()=>enforcePriceCap([{name:'Eggs',price:2.5}],context),/Price cap exceeded/);assert.doesNotThrow(()=>enforcePriceCap([{name:'Eggs',price:0.2}],context));assert.equal(a.state('buyer').rules.length,0);assert.equal(a.chat('buyer','at least 10 eggs maximum 2 euro').proposal,undefined);});
test('potato salad instruction fills target and price without unrelated examples',()=>{const a=new ManagedAgent({file:'/unused'});const result=a.chat('buyer','i want atleast 5 potato salad and at most 20, with the max price being 5 per one');assert.deepEqual(result.proposal,{query:'Potato salad',minimum:5,target:20,on_hand:0,max_price:5,price_quantity:1,currency:'EUR',price_unit:'ST'});assert.doesNotMatch(result.message,/eggs/i);assert.match(result.message,/maximum €5 per 1 ST/);assert.equal(a.chat('buyer','at least 5 potato salad and at most 2').proposal,undefined);assert.deepEqual(a.chat('buyer','at least 5 potato salad, target 20, max price 5 per one').proposal,result.proposal);});
test('price caps use verified packaging conversions and reject currency mismatches',async()=>{const {priceUnitFactor,enforcePriceCap}=await import('../src/web-demo/managed-agent.js');const item={unit:'BOX',baseUnit:'ST',units:[{unitId:'BOX',sizeInBaseUnits:12},{unitId:'PAL',sizeInBaseUnits:120}]};assert.equal(priceUnitFactor(item,'ST'),1/12);assert.equal(priceUnitFactor(item,'PAL'),10);assert.throws(()=>priceUnitFactor(item,'KG'),/No verified conversion/);const context={constraints:{max_price:2,price_quantity:1,price_unit_factor:1/12,price_unit:'ST',sales_unit:'BOX',currency:'EUR'}};assert.doesNotThrow(()=>enforcePriceCap([{name:'Box',price:24,unit:'BOX',currency:'EUR'}],context));assert.throws(()=>enforcePriceCap([{name:'Box',price:24,unit:'BOX',currency:'USD'}],context),/currency/);assert.throws(()=>enforcePriceCap([{name:'Box',price:25,unit:'BOX',currency:'EUR'}],context),/Price cap exceeded/);});
test('simulated receipt closes episode and a later shortage can reorder without duplicate receipts',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-receipt-');try{let calls=0;const args={file:dir+'/state.json',submit:async lines=>({id:'order-'+(++calls),status:'APPROVED',items:[{quantity:lines[0].quantity}]})};const a=new ManagedAgent(args);await a.load();await a.command('buyer',{action:'rule',rule:{query:'Dark beer',minimum:10,target:20,on_hand:0}});await a.tick('buyer');assert.equal(a.state('buyer').inventory.find(p=>p.id==='demo-dark-beer').on_hand,20);await a.tick('buyer');assert.equal(calls,1);await a.command('buyer',{action:'snapshot',id:'demo-dark-beer',on_hand:2});await a.tick('buyer');assert.equal(calls,2);assert.equal(a.preview('buyer')[0].position,20);const b=new ManagedAgent(args);await b.load();await b.tick('buyer');assert.equal(calls,2);assert.equal(b.preview('buyer')[0].position,20);}finally{await rm(dir,{recursive:true,force:true});}});
test('approval reconciliation receives stock once and pending orders remain held',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-approval-');try{let status='PENDING_APPROVAL',calls=0;const a=new ManagedAgent({file:dir+'/state.json',submit:async()=>{calls++;return {id:'pending',status,items:[{quantity:20}]};},listOrders:async()=>[{id:'pending',status,items:[{quantity:20}]}]});await a.command('buyer',{action:'rule',rule:{query:'milk',minimum:10,target:20,on_hand:0}});await a.tick('buyer');await a.tick('buyer');assert.equal(calls,1);assert.equal(a.preview('buyer')[0].position,0);status='APPROVED';await a.tick('buyer');await a.tick('buyer');assert.equal(calls,1);assert.equal(a.preview('buyer')[0].position,20);}finally{await rm(dir,{recursive:true,force:true});}});
test('mass and volume caps compare each product pack size independently',async()=>{const {priceUnitFactor,enforcePriceCap}=await import('../src/web-demo/managed-agent.js');assert.equal(priceUnitFactor({unit:'ST',net_contents:{kg:0.4}},'KGM'),2.5);assert.equal(priceUnitFactor({unit:'ST',net_contents:{litres:0.5}},'MLT'),0.002);const context={constraints:{max_price:5,price_quantity:1,price_unit:'KGM',currency:'EUR'}};assert.doesNotThrow(()=>enforcePriceCap([{name:'Small pack',price:2,unit:'ST',net_contents:{kg:0.4}},{name:'Large pack',price:10,unit:'ST',net_contents:{kg:2}}],context));assert.throws(()=>enforcePriceCap([{name:'Expensive pack',price:2.5,unit:'ST',net_contents:{kg:0.4}}],context),/Price cap exceeded/);assert.throws(()=>enforcePriceCap([{name:'Milk',price:1,unit:'ST',net_contents:{litres:1}}],context),/No verified net kg/);const a=new ManagedAgent({file:'/unused'});assert.equal(a.chat('buyer','at least 5 potato salad max price 5 per kg').proposal.price_unit,'KGM');assert.equal(a.chat('buyer','at least 5 milk max price 2 per liter').proposal.price_unit,'LTR');});

test('new and previously paused warehouses always monitor',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-monitoring-');try{const a=new ManagedAgent({file:dir+'/state.json'});assert.equal(a.state('new').connected,true);assert.equal(a.state('new').enabled,true);const old=a.state('buyer');old.connected=false;old.enabled=false;await a.save();const b=new ManagedAgent({file:dir+'/state.json'});await b.load();await b.tick('buyer');assert.equal(b.state('buyer').connected,true);assert.equal(b.state('buyer').enabled,true);assert.ok(b.state('buyer').last_check);await assert.rejects(b.command('buyer',{action:'pause'}),/Unknown command/);await assert.rejects(b.command('buyer',{action:'disconnect'}),/Unknown command/);}finally{await rm(dir,{recursive:true,force:true});}});

test('uncertain dispatch survives restart and requires explicit human resolution',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-uncertain-');try{let calls=0;const args={file:dir+'/state.json',listOrders:async()=>[],submit:async()=>{calls++;throw Error('connection lost');}};const a=new ManagedAgent(args);await a.command('buyer',{action:'rule',rule:{query:'Eggs',minimum:10,target:20,on_hand:0}});await a.tick('buyer');const id=a.state('buyer').rules[0].episode;assert.equal(a.state('buyer').activity.find(a=>a.id===id).status,'RECONCILING');const b=new ManagedAgent(args);await b.load();await b.tick('buyer');assert.equal(calls,1);await assert.rejects(b.command('buyer',{action:'resolve',id,resolution:'unknown'}),/explicitly confirm/);await b.command('buyer',{action:'resolve',id,resolution:'no_order'});assert.equal(b.state('buyer').rules[0].episode,null);assert.equal(b.state('buyer').activity.find(a=>a.id===id).status,'RESOLVED_NO_ORDER');}finally{await rm(dir,{recursive:true,force:true});}});
test('state lock prevents concurrent processes from dispatching twice',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-lock-');try{let release;const held=new Promise(r=>release=r);let started;const began=new Promise(r=>started=r);const args={file:dir+'/state.json',submit:async()=>{started();await held;return {id:'one',status:'PENDING_APPROVAL',items:[]};}};const a=new ManagedAgent(args),b=new ManagedAgent(args);await a.command('buyer',{action:'rule',rule:{query:'Eggs',minimum:10,target:20,on_hand:0}});const tick=a.tick('buyer');await began;await assert.rejects(b.tick('buyer'),/locked by another process/);release();await tick;}finally{await rm(dir,{recursive:true,force:true});}});
test('failed state persistence does not dispatch',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-save-');try{let calls=0;const a=new ManagedAgent({file:dir+'/state.json',submit:async()=>{calls++;}});await a.command('buyer',{action:'rule',rule:{query:'Eggs',minimum:10,target:20,on_hand:0}});a.save=async()=>{throw Error('disk full');};await assert.rejects(a.tick('buyer'),/disk full/);assert.equal(calls,0);}finally{await rm(dir,{recursive:true,force:true});}});
test('uncertain order is held until a human attaches the matching order',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-reconcile-');try{let order;const a=new ManagedAgent({file:dir+'/state.json',listOrders:async()=>order?[order]:[],submit:async(_lines,_user,context)=>{order={id:context.action_id,status:'APPROVED',items:[{quantity:20}]};throw Error('response lost');}});await a.command('buyer',{action:'rule',rule:{query:'Eggs',minimum:10,target:20,on_hand:0}});await a.tick('buyer');const id=a.state('buyer').rules[0].episode;await a.tick('buyer');assert.equal(a.state('buyer').activity.find(x=>x.id===id).status,'RECONCILING');assert.equal(a.preview('buyer')[0].position,0);await assert.rejects(a.command('buyer',{action:'resolve',id,resolution:'no_order'}),/order exists/);await a.command('buyer',{action:'resolve',id,resolution:'attach_order'});assert.equal(a.preview('buyer')[0].position,20);}finally{await rm(dir,{recursive:true,force:true});}});
test('rejected and denied episodes remain held until a human resets them',async()=>{const dir=await mkdtemp(tmpdir()+'/managed-reset-');try{let calls=0;let order={id:'pending',status:'PENDING_APPROVAL',items:[]};const a=new ManagedAgent({file:dir+'/state.json',listOrders:async()=>[order],submit:async()=>{calls++;return order;}});await a.command('buyer',{action:'rule',rule:{query:'Eggs',minimum:10,target:20,on_hand:0}});await a.tick('buyer');const id=a.state('buyer').rules[0].episode;order={...order,status:'REJECTED'};await a.tick('buyer');assert.equal(a.state('buyer').activity.find(x=>x.id===id).status,'REJECTED');await a.tick('buyer');assert.equal(calls,1);await a.command('buyer',{action:'reset_episode',id});await a.tick('buyer');assert.equal(calls,2);const denied=new ManagedAgent({file:dir+'/denied.json',submit:async()=>{throw Object.assign(Error('cap'),{code:'PRICE_CAP'});}});await denied.command('buyer',{action:'rule',rule:{query:'Eggs',minimum:1,target:2,on_hand:0}});await denied.tick('buyer');const did=denied.state('buyer').rules[0].episode;await denied.command('buyer',{action:'reset_episode',id:did});assert.equal(denied.state('buyer').rules[0].episode,null);}finally{await rm(dir,{recursive:true,force:true});}});

test('simulation cadence, pause and delayed receipt survive restart',async()=>{
  const dir=await mkdtemp(tmpdir()+'/managed-simulation-');
  try{
    let now=100000, calls=0;
    const args={file:dir+'/state.json',now:()=>now,submit:async(lines)=>({id:`order-${++calls}`,status:'APPROVED',total:10,items:[{quantity:lines[0].quantity}]})};
    const a=new ManagedAgent(args);
    await a.command('buyer',{action:'simulation',running:true,speed:'fast',governance:'autonomous'});
    assert.equal(a.state('buyer').rules.length,7);
    const before=a.state('buyer').inventory.map(i=>i.on_hand);
    now+=2999;await a.simulationStep('buyer');assert.deepEqual(a.state('buyer').inventory.map(i=>i.on_hand),before);
    now++;await a.simulationStep('buyer');assert.ok(a.state('buyer').inventory.some((i,n)=>i.on_hand<before[n]));
    await a.command('buyer',{action:'simulation',running:false});
    const paused=a.state('buyer').inventory.map(i=>i.on_hand);
    now+=10000;await a.simulationStep('buyer');assert.deepEqual(a.state('buyer').inventory.map(i=>i.on_hand),paused);
    await a.command('buyer',{action:'demand_spike'});await a.tick('buyer');assert.equal(calls,1);
    const rule=a.state('buyer').rules.find(r=>r.episode), item=a.state('buyer').inventory.find(i=>i.id===rule.product_id);
    assert.ok(item.on_hand<rule.minimum);
    const b=new ManagedAgent(args);await b.load();now+=3999;await b.simulationStep('buyer');assert.ok(b.state('buyer').inventory.find(i=>i.id===rule.product_id).on_hand<rule.minimum);
    now++;await b.simulationStep('buyer');assert.equal(b.state('buyer').inventory.find(i=>i.id===rule.product_id).on_hand,rule.target);
    await b.simulationStep('buyer');assert.equal(b.state('buyer').metrics.stockouts_prevented,1);assert.equal(calls,1);
    assert.ok(b.state('buyer').telemetry.some(e=>e.category==='RESTOCK'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('6x simulation follows the configured cadence without accumulating a backlog',async()=>{
  const dir=await mkdtemp(tmpdir()+'/managed-6x-');
  try{
    let now=100000;
    const a=new ManagedAgent({file:dir+'/state.json',now:()=>now,submit:async()=>{throw Error('unexpected order');}});
    await a.command('buyer',{action:'simulation',running:true,speed:'6x'});
    const start=a.state('buyer').inventory.map(item=>item.on_hand);
    now+=1332;await a.simulationStep('buyer');assert.deepEqual(a.state('buyer').inventory.map(item=>item.on_hand),start);
    now++;await a.simulationStep('buyer');assert.ok(a.state('buyer').inventory.some((item,index)=>item.on_hand<start[index]));
    assert.equal(a.state('buyer').simulation.next_consumption,102666);
    now+=10000;await a.simulationStep('buyer');assert.equal(a.state('buyer').simulation.next_consumption,now+1333);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('older default simulations gain products without changing custom rules or stock',async()=>{
  const dir=await mkdtemp(tmpdir()+'/managed-seed-migration-');
  try{
    const file=dir+'/state.json';
    const a=new ManagedAgent({file});
    await a.command('buyer',{action:'simulation',running:false});
    const original=a.state('buyer');
    original.rules=original.rules.slice(0,3);
    delete original.simulation.seed_version;
    original.inventory.find(item=>item.id==='demo-milk').on_hand=6;
    original.inventory.find(item=>item.id==='demo-potato-salad').on_hand=0;
    original.activity.push({status:'CONFIGURATION',message:'snapshot'});
    original.rules.push({...ruleSchema.parse({query:'Milk',minimum:3,target:12,on_hand:6}),id:'custom',product_id:'demo-milk',version:1,sales_unit:'ST',price_unit_factor:1});
    await a.save();
    const b=new ManagedAgent({file});await b.load();await b.simulationStep('buyer');
    const migrated=b.state('buyer');
    assert.equal(migrated.rules.length,7);
    assert.equal(migrated.simulation.seed_version,2);
    assert.equal(migrated.rules.find(rule=>rule.product_id==='demo-milk').minimum,3);
    assert.equal(migrated.inventory.find(item=>item.id==='demo-milk').on_hand,6);
    assert.equal(migrated.inventory.find(item=>item.id==='demo-potato-salad').on_hand,0);
    const c=new ManagedAgent({file});await c.load();
    assert.equal(c.state('buyer').rules.length,7);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('custom simulations are not reseeded on migration',async()=>{
  const dir=await mkdtemp(tmpdir()+'/managed-custom-seed-');
  try{
    const a=new ManagedAgent({file:dir+'/state.json'});
    await a.command('buyer',{action:'rule',rule:{query:'Eggs',minimum:2,target:5,on_hand:0}});
    await a.command('buyer',{action:'simulation',running:false});
    delete a.state('buyer').simulation.seed_version;
    await a.save();await a.simulationStep('buyer');
    assert.equal(a.state('buyer').rules.length,1);
    assert.equal(a.state('buyer').rules[0].minimum,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('simulation holds a missing pending order for reconciliation',async()=>{
  const dir=await mkdtemp(tmpdir()+'/managed-simulation-reconnect-');
  try{
    let orders=[];
    const a=new ManagedAgent({file:dir+'/state.json',submit:async lines=>{const order={id:'pending',status:'PENDING_APPROVAL',items:[{quantity:lines[0].quantity}]};orders=[order];return order;},listOrders:async()=>orders});
    await a.command('buyer',{action:'simulation',governance:'human'});
    await a.command('buyer',{action:'demand_spike'});await a.tick('buyer');
    orders=[];await a.tick('buyer');
    const episode=a.state('buyer').activity.find(event=>event.id===a.state('buyer').rules.find(rule=>rule.episode)?.episode);
    assert.equal(episode.status,'RECONCILING');assert.match(episode.message,/unavailable/);
    await a.command('buyer',{action:'resolve',id:episode.id,resolution:'no_order'});
    assert.equal(a.state('buyer').rules.find(rule=>rule.id===episode.context.why.rule_id).episode,null);
  }finally{await rm(dir,{recursive:true,force:true});}
});
