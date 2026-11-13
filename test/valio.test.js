import test from 'node:test';
import assert from 'node:assert/strict';
import { ValioClient } from '../src/valio.js';
const request = { customer: 'customer-a', requestedDate: '2026-11-16', products: ['460000'] };
test('live client uses exact Valio contract and authentication', async () => {
  const client = new ValioClient({ mock: false, apiKey: 'test-secret', fetchImpl: async (url,options) => {
    assert.equal(url.pathname,'/api/price'); assert.equal(options.headers['X-API-Key'],'test-secret');
    assert.deepEqual(JSON.parse(options.body),request);
    return Response.json({ products: [{ productId: '460000' }] });
  } });
  await client.price(request);
});
test('rejects oversized, duplicate and invalid-date requests before network calls', async () => {
  let calls = 0;
  const client = new ValioClient({ mock: false, apiKey: 'test', fetchImpl: () => { calls++; } });
  for (const bad of [{ products: Array.from({length:1001},(_,i) => String(i)) },{ products:['460000','460000'] },{ requestedDate:'2026-02-30' }]) {
    await assert.rejects(client.price({ ...request,...bad }));
  }
  assert.equal(calls,0);
});
test('rate limits are surfaced without automatic retries', async () => {
  let calls = 0;
  const client = new ValioClient({ mock:false,apiKey:'test',fetchImpl:async () => { calls++; return new Response('',{status:429}); } });
  await assert.rejects(client.availability(request),error => error.status === 429);
  assert.equal(calls,1);
});
test('missing or malformed upstream responses fail closed', async () => {
  for (const response of [Response.json({products:[]}),new Response('invalid-json')]) {
    const client = new ValioClient({mock:false,apiKey:'test',fetchImpl:async () => response});
    await assert.rejects(client.price(request),error => error.status === 502);
  }
});
