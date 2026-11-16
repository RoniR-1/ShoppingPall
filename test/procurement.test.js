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
  client.snapshotClient = { availability: async request => {
    calls.push('database'); requests.push({ method: 'DB', path: '/api/availability', body: request });
    return {timeNow:'2026-11-14T00:00:00Z',requestedDate:request.requestedDate,products:request.products.map(id => ({
      productId:id, salesBlock:blocked, logisticModel:terminal?'Terminal':'Stock', closingTime:null,
      scheduleLines:[{salesBlock:scheduleBlock,availableAmount:terminal?999999:amounts[['a','b','c'].indexOf(id)],availableDate:request.requestedDate,salesUnit:'KG'}]
    }))};
  }};
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
  const pending = await session.process(line);
  assert.deepEqual(pending.pendingIntervention[0].suggestions, ['b']);
  const result = await session.process(line, { approvedProductIds: ['b'] });
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
  await session.process({...line,quantity:6});
  const result = await session.process({...line,quantity:6}, {approvedProductIds:['b']});
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
  await session.run([line]);
  const result = await session.process(line, {approvedProductIds:['b']});
  assert.deepEqual(requests, [
    {method:'GET', path:'/api/products/download', body:undefined},
    {method:'DB', path:'/api/availability', body:{customer:'test', requestedDate:'2026-11-16', products:['a']}},
    {method:'DB', path:'/api/availability', body:{customer:'test', requestedDate:'2026-11-16', products:['b']}}
  ]);
  assert.deepEqual(result.completedOrders.map(({productId, quantity, remainingStock}) => ({productId, quantity, remainingStock})), [
    {productId:'a', quantity:2, remainingStock:0}, {productId:'b', quantity:3, remainingStock:0}
  ]);
  assert.equal(result.simulated, true);
});
test('run stops after a shortfall without processing later lines', async () => {
  const {session, requests} = setup({amounts:[1,1,9]});
  console.log('Expected: allocate 1 KG each from a and b, report a 3 KG shortfall, and stop before checking c.');
  await session.run([line, {...line,id:'later',preferred:{id:'c'}}]);
  const result = await session.process(line, {approvedProductIds:['b']});
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
test('failed availability rolls back allocations and cached stock', async () => {
  const {session} = setup();
  const first = session.client.availability.bind(session.client);
  let calls = 0;
  session.client.availability = async body => {
    if (++calls === 1) throw Error('upstream failed');
    return first(body);
  };
  await assert.rejects(session.process(line), /upstream failed/);
  assert.deepEqual(session.summary().completedOrders, []);
  assert.deepEqual(session.summary().pendingIntervention, []);
  const pending = await session.process(line);
  assert.equal(pending.pendingIntervention[0].shortfall, 3);
});
test('substitute must preserve required constraints and be explicitly approved', async () => {
  const {session, catalog} = setup();
  const products = await catalog.download();
  products[0].countryOfOrigin = 'FI'; products[1].countryOfOrigin = 'SE';
  const result = await session.process({...line, required:{category:'food', countryOfOrigin:'FI'}});
  assert.equal(result.pendingIntervention[0].shortfall, 3);
  assert.deepEqual(result.pendingIntervention[0].suggestions, []);
  await assert.rejects(session.process({...line, required:{category:'food', countryOfOrigin:'FI'}}, {approvedProductIds:['b']}), /proposed eligible/);
});
test('explicit shortfall acceptance or rejection only resolves simulation', async () => {
  const {session} = setup();
  await session.process(line);
  const accepted = session.resolveShortfall('one', 'accept');
  assert.deepEqual(accepted.resolutions, [{lineId:'one',status:'SHORTFALL_ACCEPTED',fulfilled:2,shortfall:3}]);
  assert.equal((await session.process(line)).completedOrders.length, 1);
  const second = setup().session;
  await second.process(line);
  const rejected = second.resolveShortfall('one', 'reject');
  assert.equal(rejected.completedOrders.length, 0);
  assert.equal(rejected.inventory.a.remaining, 2);
  assert.equal(rejected.resolutions[0].status, 'REJECTED');
  assert.throws(() => second.resolveShortfall('one', 'accept'), /No pending/);
});
test('no-match suggestions remain available after an unavailable selection', async () => {
  const {session} = setup({amounts:[0,0,0]});
  const missing = {...line, preferred:{id:'missing'}};
  await session.process(missing);
  const result = await session.process(missing, {approvedProductIds:['a']});
  assert.deepEqual(result.pendingIntervention[0].suggestions, ['a','b','c']);
  assert.throws(() => session.resolveShortfall('one','accept'), /no allocated stock/);
});
test('cutoff, delivery date, unit, lots and unknown stock fail closed', async () => {
  for (const patch of [
    {closingTime:'2026-11-14T12:00:00'}, {closingTime:'2026-11-14T12:00:00Z'},
    {scheduleLines:[{salesBlock:false,availableAmount:10,availableDate:'2026-11-17',salesUnit:'KG'}]},
    {scheduleLines:[{salesBlock:false,availableAmount:10,availableDate:'2026-11-16',salesUnit:'PCS'}]},
    {logisticModel:'Terminal'}
  ]) {
    const {session} = setup();
    session.now = () => new Date('2026-11-14T12:00:00Z');
    const original = session.client.availability.bind(session.client);
    session.client.availability = async body => {
      const result = await original(body);
      result.products.forEach(p => Object.assign(p, patch));
      return result;
    };
    const result = await session.process(line);
    assert.equal(result.completedOrders.length, 0, JSON.stringify(patch));
    assert.equal(result.pendingIntervention[0].shortfall, 5);
  }
  const {session,catalog} = setup({amounts:[5,3,9]});
  (await catalog.download())[0].allowedLotSize = 4;
  const result = await session.process({...line,quantity:5});
  assert.equal(result.completedOrders[0].quantity,4);
  assert.equal(result.pendingIntervention[0].shortfall,1);
});
test('failed second availability batch rolls back entire session', async () => {
  const products = Array.from({length:1001},(_,i)=>({id:String(i),salesUnit:'KG',allowedLotSize:1}));
  let calls = 0;
  const catalog = { search:async () => products, download:async () => products, matches:() => true };
  const client = {availability:async ({products:ids}) => {
    if (++calls === 2) throw Error('batch failed');
    return {products:ids.map(productId => ({productId,logisticModel:'Stock',salesBlock:false,closingTime:null,scheduleLines:[{salesBlock:false,availableAmount:1,availableDate:'2026-11-16',salesUnit:'KG'}]}))};
  }};
  const session = new ProcurementSession({catalog,client,customer:'test',requestedDate:'2026-11-16'});
  await assert.rejects(session.process({id:'batch',quantity:1001,salesUnit:'KG'}), /batch failed/);
  assert.deepEqual(session.summary().inventory, {});
  assert.deepEqual(session.summary().pendingIntervention, []);
});
test('concurrent processing is rejected without mutating state', async () => {
  const {session} = setup();
  const original = session.catalog.search.bind(session.catalog);
  let release;
  const barrier = new Promise(resolve => {release = resolve;});
  session.catalog.search = async (...args) => { await barrier; return original(...args); };
  const first = session.process(line);
  await assert.rejects(session.process({...line,id:'two'}), /already processing/);
  release(); await first;
  assert.equal(session.summary().pendingIntervention.length, 1);
});
test('client strips key after cross-origin HTTPS redirect and retains one deadline', async () => {
  const calls=[];
  const client=new ProcurementClient({baseUrl:'https://supplier.test',apiKey:'secret',fetchImpl:async (url,options)=>{
    calls.push({url:String(url), ...options});
    return calls.length === 1 ? new Response('',{status:302,headers:{location:'https://cdn.test/file'}}) : new Response('[]');
  }});
  assert.equal(await client.request('/api/products/download','GET'), '[]');
  assert.equal(calls[0].headers['X-API-Key'],'secret');
  assert.equal(calls[1].headers['X-API-Key'],undefined);
  assert.equal(calls[0].signal,calls[1].signal);
});
test('procurement price and availability do not use supplier HTTP', async () => {
  const client = new ProcurementClient({baseUrl:'https://supplier.test',apiKey:'secret',fetchImpl:async()=>{throw Error('network called');},snapshotClient:{availability:async()=>({products:[]}),price:async()=>({products:[]})}});
  const request = {customer:'test', requestedDate:'2026-11-16', products:['a']};
  assert.deepEqual(await client.availability(request), {products:[]});
  assert.deepEqual(await client.price(request), {products:[]});
  await assert.rejects(client.request('/api/price','POST',{}), /offline export/);
});
for (const decision of ['accept', 'reject']) test(`run resumes later lines after a human chooses to ${decision} a shortfall`, async () => {
  const {session} = setup({amounts:[2,3,9]});
  const later = {...line,id:'later',quantity:1,preferred:{id:'c'}};
  await session.run([line,later]);
  session.resolveShortfall('one', decision);
  const result = await session.run([line,later]);
  assert.ok(result.completedOrders.some(item => item.lineId === 'later' && item.productId === 'c'));
  assert.equal(result.pendingIntervention.length,0);
});
