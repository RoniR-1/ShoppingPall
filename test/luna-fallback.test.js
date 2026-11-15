import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callGeminiJSON, configuredLunaModels} from '../src/web-demo/luna.js';

const makeEnv = () => ({LUNA_BASE_URL:'https://example.test/v1', LUNA_API_KEY:'key', LUNA_MODELS:'high,mid,low', LUNA_TIMEOUT_MS:'500', LUNA_COOLDOWN_MS:'60000'});
const ok = model => Response.json({choices:[{message:{content:JSON.stringify({model})}}]});
const busy = () => Response.json({error:{message:'busy'}},{status:503});

test('fallback skips cooling tiers and restores higher priority on recovery', async (t) => {
  let now=100000; t.mock.method(Date, 'now', () => now);
  const env=makeEnv(), calls=[]; let recovered=false;
  const fetchImpl=async (_url, options) => {const model=JSON.parse(options.body).model; calls.push(model); return model==='high'&&!recovered?busy():ok(model);};
  assert.deepEqual(await callGeminiJSON('s','u',{env,fetchImpl}),{model:'mid'});
  assert.deepEqual(await callGeminiJSON('s','u',{env,fetchImpl}),{model:'mid'});
  assert.deepEqual(calls,['high','mid','mid']);
  recovered=true; now+=60001;
  assert.deepEqual(await callGeminiJSON('s','u',{env,fetchImpl}),{model:'high'});
});

test('timeout includes response body and tries the next model', async () => {
  const env=makeEnv(), calls=[]; env.LUNA_TIMEOUT_MS='25';
  const fetchImpl=async (_url,options) => {const model=JSON.parse(options.body).model; calls.push(model); return model==='high'?{ok:true,status:200,text:()=>new Promise(()=>{})}:ok(model);};
  assert.deepEqual(await callGeminiJSON('s','u',{env,fetchImpl}),{model:'mid'});
  assert.deepEqual(calls,['high','mid']);
});

test('exhaustion is bounded and all cooling models fail fast', async () => {
  const env=makeEnv(); let calls=0;
  const fetchImpl=async()=>{calls++;return new Response('busy',{status:429});};
  await assert.rejects(callGeminiJSON('s','u',{env,fetchImpl}),{code:'AI_RATE_LIMITED'});
  await assert.rejects(callGeminiJSON('s','u',{env,fetchImpl}),{code:'AI_RATE_LIMITED'});
  assert.equal(calls,3);
});

test('authentication and malformed responses do not trigger fallback', async () => {
  for (const response of [new Response('unauthorized',{status:401}),new Response('invalid',{status:200})]) {
    const env=makeEnv();let calls=0;
    await assert.rejects(callGeminiJSON('s','u',{env,fetchImpl:async()=>{calls++;return response;}}));
    assert.equal(calls,1);
  }
});

test('only one recovery probe runs at once', async (t) => {
  let now=100000; t.mock.method(Date, 'now', () => now);
  const env=makeEnv(), calls=[]; let release;
  const fetchImpl=async (_url,options)=>{const model=JSON.parse(options.body).model;calls.push(model);if(model==='high' && calls.length===1)return busy();if(model==='high')return new Promise(resolve=>{release=()=>resolve(ok(model));});return ok(model);};
  await callGeminiJSON('s','u',{env,fetchImpl}); now+=60001;
  const probe=callGeminiJSON('s','u',{env,fetchImpl});
  assert.deepEqual(await callGeminiJSON('s','u',{env,fetchImpl}),{model:'mid'});
  release();assert.deepEqual(await probe,{model:'high'});
  assert.deepEqual(calls,['high','mid','high','mid']);
});

test('model configuration supports defaults and legacy single model',()=>{
  assert.deepEqual(configuredLunaModels({}),['gemini-3.8-flash','gemini-3.6-flash','gemini-3.5-flash-lite','gemini-3.1-flash-lite']);
  assert.deepEqual(configuredLunaModels({LUNA_MODEL:'legacy'}),['legacy']);
  assert.deepEqual(configuredLunaModels({LUNA_MODELS:' first, second ',LUNA_MODEL:'legacy'}),['first','second']);
});
