import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { ProcurementClient } from '../src/procurement/client.js';
import { Catalog } from '../src/procurement/catalog.js';
import { ProcurementSession } from '../src/procurement/session.js';
const show = (label, value) => console.log(`${label}: ${JSON.stringify(value, null, 2)}`);
const test = (name, fn) => nodeTest(name, async () => {
  console.log(`\n=== ${name} ===`);
  await fn();
  console.log(`PASS: ${name}`);
});

function setup({ amounts = [2,3,9], terminal = false, blocked = false, scheduleBlock = false } = {}) {
  show('Starting stock and restrictions', { stock: { a: amounts[0], b: amounts[1], c: amounts[2] }, terminal, blocked, scheduleBlock, substitutions: { a: 'b', b: 'c' } });
  const products = ['a','b','c'].map((id,i) => ({ id, salesUnit:'KG', allowedLotSize:1, category:'food', substitutions: i < 2 ? [{product:id,substituteProduct:['b','c'][i]}] : [] }));
  const calls = [];
  const requests = [];
  const client = new ProcurementClient({baseUrl:'https://example.test',apiKey:'secret',fetchImpl:async (url, options) => {
    calls.push(String(url));
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method: options.method, path: new URL(url).pathname, body });
    show('  Mock API request', { method: options.method, path: new URL(url).pathname, body });
    assert.equal(options.headers['X-API-Key'], 'secret');
    if (options.method === 'GET') return new Response(JSON.stringify(products));
    const request = JSON.parse(options.body);
    return Response.json({timeNow:'2026-11-14T00:00:00Z',requestedDate:request.requestedDate,products:request.products.map(id => ({
      productId:id, salesBlock:blocked, logisticModel:terminal?'Terminal':'Stock', closingTime:null,
      scheduleLines:[{salesBlock:scheduleBlock,availableAmount:terminal?999999:amounts[['a','b','c'].indexOf(id)],availableDate:request.requestedDate,salesUnit:'KG'}]
    }))});
  }});
  const catalog = new Catalog(client);
  const session = new ProcurementSession({client,catalog,customer:'test',requestedDate:'2026-11-16'});
  for (const method of ['process', 'run']) {
    const original = session[method].bind(session);
    session[method] = async (...args) => {
      show(`\nAction: ${method}`, args);
      try {
        const result = await original(...args);
        show(`Result: ${method}`, result);
        return result;
      } catch (error) {
        show(`Result: ${method} rejected`, error.message);
        throw error;
      }
    };
  }
  return {session,catalog,calls,requests,client};
}
const line = {id:'one',quantity:5,salesUnit:'KG',required:{category:'food'},preferred:{id:'a'}};
test('splits direct substitutions, tracks stock and idempotent replay',async () => {
  const {session,calls,catalog} = setup();
  console.log('Expected: fulfill 5 KG with 2 KG of a and 3 KG of b; a replay uses no stock, then the next line has a 5 KG shortfall.');
  const result = await session.process(line);
  assert.deepEqual(result.completedOrders.map(p => p.quantity),[2,3]);
  assert.equal(result.pendingIntervention.length,0);
  await session.process(line);
  await catalog.download();
  assert.equal(calls.filter(c => c.endsWith('/download')).length,1);
  const next = await session.process({...line,id:'two'});
  assert.equal(next.pendingIntervention[0].shortfall,5);
  assert.equal(calls.length,3);
});
test('never follows a substitute to its substitute',async () => {
  const {session} = setup();
  console.log('Expected: use a and its direct substitute b only; leave a 1 KG shortfall and do not use c.');
  const result = await session.process({...line,quantity:6});
  assert.equal(result.pendingIntervention[0].shortfall,1);
  assert.equal(result.inventory.c,undefined);
});
for (const options of [{terminal:true},{blocked:true},{scheduleBlock:true}]) test('unavailable stock escalates '+JSON.stringify(options),async () => {
  console.log('Expected: no completed order and a SHORTFALL intervention.');
  const {session} = setup(options);
  const result = await session.process(line);
  assert.equal(result.completedOrders.length,0);
  assert.equal(result.pendingIntervention[0].reason,'SHORTFALL');
});
test('zero matches suggests alternatives and waits for explicit approval',async () => {
  const {session,calls} = setup();
  console.log('Expected: NO_MATCH until proposed products are explicitly approved, then fulfill the line.');
  const missing = {...line,preferred:{id:'missing'}};
  const result = await session.process(missing);
  assert.equal(result.pendingIntervention[0].reason,'NO_MATCH');
  assert.equal(calls.length,1);
  const approved = await session.process(missing,{approvedProductIds:['a','b']});
  assert.equal(approved.pendingIntervention.length,0);
});
test('validates requests against OpenAPI',async () => {
  const {client} = setup();
  console.log('Expected: invalid date and empty products are rejected before any API request.');
  await assert.rejects(client.availability({customer:'test',requestedDate:'invalid',products:['a']}));
  await assert.rejects(client.availability({customer:'test',requestedDate:'2026-11-16',products:[]}));
});

test('workflow calls catalog once and availability only for original and direct substitute', async () => {
  const {session, requests} = setup();
  console.log('Expected: download catalog once, check a then b, and allocate 2 KG and 3 KG with zero remaining stock.');
  const result = await session.run([line]);
  assert.deepEqual(requests, [
    {method:'GET', path:'/api/products/download', body:undefined},
    {method:'POST', path:'/api/availability', body:{customer:'test', requestedDate:'2026-11-16', products:['a']}},
    {method:'POST', path:'/api/availability', body:{customer:'test', requestedDate:'2026-11-16', products:['b']}}
  ]);
  assert.deepEqual(result.completedOrders.map(({productId, quantity, remainingStock}) => ({productId, quantity, remainingStock})), [
    {productId:'a', quantity:2, remainingStock:0}, {productId:'b', quantity:3, remainingStock:0}
  ]);
  assert.equal(result.simulated, true);
});
test('run stops after a shortfall without processing later lines', async () => {
  const {session, requests} = setup({amounts:[1,1,9]});
  console.log('Expected: allocate 1 KG each from a and b, report a 3 KG shortfall, and stop before checking c.');
  const result = await session.run([line, {...line,id:'later',preferred:{id:'c'}}]);
  assert.equal(result.pendingIntervention[0].shortfall,3);
  assert.deepEqual(result.completedOrders.map(p => p.productId), ['a','b']);
  assert.equal(requests.some(r => r.body?.products?.includes('c')), false);
});
test('rejects approval for an unproposed product before availability', async () => {
  const {session, requests} = setup();
  console.log('Expected: reject an unproposed approval without making an availability request.');
  const missing = {...line, preferred:{id:'missing'}};
  await session.process(missing);
  await assert.rejects(session.process(missing,{approvedProductIds:['unknown']}), /proposed eligible/);
  assert.equal(requests.length,1);
});
