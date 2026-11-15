import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {acquireStateLock} from '../src/web-demo/state-lock.js';
import {ManagedAgent} from '../src/web-demo/managed-agent.js';

async function fixture(fn) {
 const dir = await mkdtemp(`${tmpdir()}/state-lock-`);
 try { await fn(`${dir}/state.json`); } finally { await rm(dir,{recursive:true,force:true}); }
}

test('live lock holder cannot be stolen and waiter succeeds after release', () => fixture(async file => {
 const release = await acquireStateLock(`${file}.lock`);
 await assert.rejects(acquireStateLock(`${file}.lock`,{waitMs:50}),{code:'MANAGED_STATE_LOCKED'});
 const waiting = acquireStateLock(`${file}.lock`,{waitMs:2000});
 await release();
 await (await waiting)();
}));

test('concurrent writers serialize despite an abandoned legacy lock', () => fixture(async file => {
 await mkdir(`${file}.lock`);
 await writeFile(`${file}.lock/owner.json`,'old owner');
 let active=0, maximum=0;
 await Promise.all(Array.from({length:6}, async () => {
  const release = await acquireStateLock(`${file}.lock`,{waitMs:3000});
  maximum = Math.max(maximum,++active);
  await new Promise(resolve => setTimeout(resolve,10));
  active--;
  await release();
 }));
 assert.equal(maximum,1);
 assert.equal(await readFile(`${file}.lock/owner.json`,'utf8'),'old owner');
}));

test('a crashed process releases its kernel lock', () => fixture(async file => {
 const moduleUrl = new URL('../src/web-demo/state-lock.js',import.meta.url).href;
 const child = spawn(process.execPath,['--input-type=module','-e',
  `import {acquireStateLock} from ${JSON.stringify(moduleUrl)}; await acquireStateLock(process.argv[1]); console.log('ready'); setInterval(()=>{},1000);`,`${file}.lock`],{stdio:['ignore','pipe','pipe']});
 try {
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('child exited before acquiring lock');})]);
  await assert.rejects(acquireStateLock(`${file}.lock`,{waitMs:50}),{code:'MANAGED_STATE_LOCKED'});
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  await (await acquireStateLock(`${file}.lock`,{waitMs:1000}))();
 } finally { if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); }
}));

test('legacy lock does not retry uncertain dispatches', () => fixture(async file => {
 let dispatches=0;
 const agent=new ManagedAgent({file,submit:async()=>{dispatches++;}});
 await agent.command('buyer',{action:'rule',rule:{query:'Eggs',minimum:10,target:20,on_hand:0}});
 const state=agent.state('buyer');state.rules[0].episode='uncertain';state.activity.push({id:'uncertain',status:'SUBMITTING'});
 await agent.save();
 await mkdir(`${file}.lock`);
 await agent.tick('buyer');
 assert.equal(agent.state('buyer').activity.find(x=>x.id==='uncertain').status,'RECONCILING');
 assert.equal(dispatches,0);
}));
