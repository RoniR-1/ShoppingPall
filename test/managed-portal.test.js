import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

async function freePort(){
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test('managed portal serves its page, drafts rules, enforces caps and reconciles approvals',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'managed-portal-'));
  const ports=await Promise.all([freePort(),freePort(),freePort()]);
  const env={...process.env,PORT:String(ports[0]),HOST:'127.0.0.1',FRONTEND_PORT:String(ports[0]),MIDDLE_LAYER_PORT:String(ports[1]),BACKEND_PORT:String(ports[2]),MANAGED_STATE_FILE:join(dir,'state.json'),LUNA_API_KEY:'',SUSPICION_THRESHOLD:'0'};
  const children=[];
  t.after(async()=>{
    await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode)return resolve();child.once('exit',resolve);child.kill();})));
    await rm(dir,{recursive:true,force:true});
  });
  for(const name of ['core','middle','frontend']){
    const child=spawn(process.execPath,[`src/web-demo/${name}.js`],{env,stdio:['ignore','pipe','pipe']});
    children.push(child);
    await new Promise((resolve,reject)=>{
      let output='';
      const timeout=setTimeout(()=>reject(Error(`Startup timed out: ${name}: ${output}`)),10000);
      const ready={core:'Core :',middle:'Middle :',frontend:'Portal http://'}[name];
      child.stdout.on('data',chunk=>{output+=chunk;if(output.includes(ready)){clearTimeout(timeout);resolve();}});
      child.stderr.on('data',chunk=>{output+=chunk;});
      child.once('exit',code=>{clearTimeout(timeout);reject(Error(`${name} exited ${code}: ${output}`));});
    });
  }
  const base=`http://127.0.0.1:${ports[0]}`;
  async function api(path,body,source='demo'){
    const response=await fetch(base+'/portal'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Data-Source':source},body:body?JSON.stringify(body):undefined});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  }
  const page=await fetch(base+'/managed-agent');
  assert.equal(page.status,200);
  const managedHtml=await page.text();
  assert.match(managedHtml,/Managed Inventory Agent/);
  assert.match(managedHtml,/href="\/style.css"/);
  const root=await fetch(base+'/',{redirect:'manual'});
  assert.equal(root.status,302);
  assert.equal(root.headers.get('location'),'/user-agent-demo');
  const demo=await fetch(base+'/user-agent-demo');
  assert.equal(demo.status,200);
  assert.match(await demo.text(),/01 · Order input/);
  const script=await fetch(base+'/managed-agent.js');
  assert.equal(script.status,200);
  // Approval requests must stay in the demo source even though the portal defaults to real.
  assert.match(await script.text(),/headers:\{'Content-Type':'application\/json','X-Data-Source':'demo'\},body:JSON.stringify\(\{user_id:user\}\)/);
  const state=user=>api('/managed-agent?user_id='+user);
  const command=(user,body)=>api('/managed-agent',{user_id:user,...body});
  assert.equal((await state('buyer')).inventory.length,7);
  const draft=await api('/managed-agent/chat',{user_id:'buyer',text:'Keep at least 10 eggs'});
  assert.equal(draft.proposal.query,'Eggs');
  assert.equal((await state('buyer')).rules.length,0);
  await command('buyer',{action:'rule',rule:{...draft.proposal,max_price:3,price_unit:'ST'}});
  await command('buyer',{action:'check'});
  let current=await state('buyer');
  assert.equal(current.orders.length,1);
  const order=current.orders[0];
  assert.equal(order.status,'PENDING_APPROVAL');
  assert.equal(order.context.agent.type,'managed');
  assert.equal(order.id,order.context.action_id);
  await command('buyer',{action:'check'});
  assert.equal((await state('buyer')).orders.length,1);
  await api(`/orders/${order.id}/approve`,{user_id:'buyer'});
  await command('buyer',{action:'check'});
  current=await state('buyer');
  assert.equal(current.inventory.find(p=>p.id==='demo-eggs').on_hand,20);
  assert.equal(current.orders.length,1);
  // A per-kg cap must use the quote's net contents before any order is saved.
  await command('capped',{action:'rule',rule:{query:'Eggs',minimum:1,target:2,on_hand:0,max_price:5,price_quantity:1,price_unit:'KGM'}});
  await command('capped',{action:'check'});
  const capped=await state('capped');
  assert.equal(capped.orders.length,0);
  assert.equal(capped.activity.at(-1).status,'DENIED');
  assert.match(capped.activity.at(-1).message,/Price cap exceeded/);
  await command('buyer',{action:'snapshot',id:'demo-eggs',on_hand:30});
  assert.equal((await state('buyer')).preview[0].quantity,0);
  const rejected=await fetch(base+'/portal/managed-agent?user_id=buyer',{headers:{'X-Data-Source':'real'}});
  assert.equal(rejected.status,422);
});
