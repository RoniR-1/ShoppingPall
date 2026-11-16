import test from 'node:test';
import assert from 'node:assert/strict';
import { ValioExportClient as ValioClient } from '../src/valio-export-client.js';
const request = { customer: 'customer-a', requestedDate: '2026-11-16', products: ['460000'] };
test('live client uses exact Valio contract and authentication', async () => {
  const client = new ValioClient({ mock: false, apiKey: 'test-secret', fetchImpl: async (url,options) => {
    assert.equal(url.pathname,'/api/price'); assert.equal(options.headers['X-API-Key'],'test-secret');
    assert.deepEqual(JSON.parse(options.body),request);
    return Response.json({ customerId: 'customer-a', currency: 'EUR', pricingDate: '2026-11-16', products: [{ productId: '460000', quantity: 1, netPriceFound: false, error: false }] });
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
test('valid JSON with invalid schema or response identity fails closed', async () => {
  const base = {customerId:'customer-a', currency:'EUR', pricingDate:'2026-11-16', products:[{productId:'460000', quantity:1, netPriceFound:false, error:false}]};
  for (const body of [{...base, products:[{productId:'460000'}]}, {...base, customerId:'other'}, {...base, products:[base.products[0],base.products[0]]}]) {
    const client = new ValioClient({mock:false,apiKey:'test',fetchImpl:async () => Response.json(body)});
    await assert.rejects(client.price(request), error => error.status === 502);
  }
});
test('live errors never switch to mock and never follow redirects', async () => {
  let calls=0;
  const client = new ValioClient({mock:false,apiKey:'test',fetchImpl:async (_url, options) => {
    calls++; assert.equal(options.redirect, 'error'); throw new TypeError('network error');
  }});
  await assert.rejects(client.price(request), error => error.status === 502);
  assert.equal(calls,1);
});
