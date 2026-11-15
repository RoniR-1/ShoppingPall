import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compatibleProduct, concernsSelfHarm} from '../src/web-demo/text.js';
import {callGeminiJSON} from '../src/web-demo/luna.js';

test('self-harm language is recognized even in a mixed shopping request', () => {
 assert.equal(concernsSelfHarm('i want to fucking kill myself and then eat 2 kebabs and 2 apples'),true);
 assert.equal(concernsSelfHarm('order 2 kebabs and 2 apples'),false);
});

test('serving vessels are excluded unless explicitly requested', () => {
 assert.equal(compatibleProduct('milkie',{name:'MILK JUG 0,3L'}),false);
 assert.equal(compatibleProduct('milk',{name:'MILK/WATER JUG 1L'}),false);
 assert.equal(compatibleProduct('milk jug',{name:'MILK JUG 0,3L'}),true);
 assert.equal(compatibleProduct('milk',{name:'MILK 1L'}),true);
});

test('provider refusal and invalid content fail closed with actionable errors', async () => {
 const env={LUNA_BASE_URL:'https://luna.example',LUNA_API_KEY:'secret'};
 const request=message=>callGeminiJSON('system','user',{env,fetchImpl:async()=>new Response(JSON.stringify({choices:[message]}),{status:200})});
 await assert.rejects(request({finish_reason:'content_filter',message:{content:null}}),{code:'AI_REFUSAL',status:422});
 await assert.rejects(request({message:{refusal:'no',content:null}}),{code:'AI_REFUSAL',status:422});
 await assert.rejects(request({message:{content:'Sorry, cannot help'}}),e=>e.code==='AI_INVALID_RESPONSE'&&e.message.includes('no order was placed'));
});

test('a provider website returned in place of the API response identifies the base URL problem', async () => {
 const env={LUNA_BASE_URL:'https://example.com/api-keys',LUNA_API_KEY:'secret'};
 for(const [body,headers] of [['<!doctype html><html></html>',{}],['web page',{'Content-Type':'text/html; charset=utf-8'}]]) {
  await assert.rejects(callGeminiJSON('system','user',{env,fetchImpl:async()=>new Response(body,{status:200,headers})}),
   e=>e.code==='AI_INVALID_RESPONSE'&&e.message.includes('LUNA_BASE_URL')&&e.message.includes('API base URL'));
 }
});
