import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { acquireStateLock } from '../src/web-demo/state-lock.js';
import { ManagedAgent } from '../src/web-demo/managed-agent.js';

async function fixture(fn) {
  const dir = await mkdtemp(`${tmpdir()}/state-lock-`);
  try { await fn(`${dir}/state.json`); } finally { await rm(dir,{recursive:true,force:true}); }
}
async function stale(file) {
  await mkdir(`${file}.lock`);
  await writeFile(`${file}.lock/owner.json`, JSON.stringify({pid:2147483647,host:hostname(),token:'dead'}));
}

test('live owner is not stolen and a waiter succeeds when released', () => fixture(async file => {
  const release = await acquireStateLock(`${file}.lock`);
  await assert.rejects(acquireStateLock(`${file}.lock`, {waitMs:50,retryMs:5}), {code:'MANAGED_STATE_LOCKED'});
  const waiting = acquireStateLock(`${file}.lock`, {waitMs:500,retryMs:5});
  await release();
  await (await waiting)();
}));

test('concurrent stale recovery serializes writers and retains ownership', () => fixture(async file => {
  await stale(file);
  let active = 0, maximum = 0;
  await Promise.all(Array.from({length:6}, async () => {
    const release = await acquireStateLock(`${file}.lock`, {waitMs:2000,retryMs:5});
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    await release();
  }));
  assert.equal(maximum, 1);
}));

test('legacy ownerless lock is not silently removed', () => fixture(async file => {
  await mkdir(`${file}.lock`);
  await assert.rejects(acquireStateLock(`${file}.lock`, {waitMs:20,retryMs:5}), {code:'MANAGED_STATE_LOCKED'});
}));

test('a former owner cannot release a replaced lock', () => fixture(async file => {
  const release = await acquireStateLock(`${file}.lock`);
  await writeFile(`${file}.lock/owner.json`, JSON.stringify({pid:process.pid,host:hostname(),token:'replacement'}));
  await release();
  assert.equal(JSON.parse(await readFile(`${file}.lock/owner.json`)).token, 'replacement');
}));

test('dead-owner recovery preserves uncertain dispatch and never retries it', () => fixture(async file => {
  let dispatches = 0;
  const agent = new ManagedAgent({file, submit: async () => { dispatches++; }});
  await agent.command('buyer',{action:'rule',rule:{query:'Eggs',minimum:10,target:20,on_hand:0}});
  const state = agent.state('buyer');
  state.rules[0].episode='uncertain';
  state.activity.push({id:'uncertain',status:'SUBMITTING'});
  await agent.save();
  await stale(file);
  await agent.tick('buyer');
  assert.equal(agent.state('buyer').activity.find(x=>x.id==='uncertain').status,'RECONCILING');
  assert.equal(dispatches,0);
}));
