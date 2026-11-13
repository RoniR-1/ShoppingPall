import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { ValioClient } from '../src/valio.js';
import { recipeCart } from '../src/agent.js';
test('PostgreSQL-backed catalog, quotes, and approval workflow', async t => {
  const user = `test-${randomUUID()}`;
  let calls = 0;
  const valio = new ValioClient({mock:true});
  const original = valio.call.bind(valio);
  valio.call = (...args) => { calls++; return original(...args); };
  const server = createApp({valio}).listen(0,'127.0.0.1');
  await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(path,body,identity=user,key=randomUUID()) {
    const response = await fetch(base+path,{method:body === undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-User-Id':identity,'Idempotency-Key':key},...(body === undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  }
  try {
    let selection, quote;
    await t.test('static joins preserve source values and issue a user-bound selection', async () => {
      const result = await api('/catalog/search?product_id=460000');
      assert.equal(result.status,200); selection=result.body;
      assert.equal(Number(selection.products[0].carbon_kg_co2_per_kg),2.315);
      assert.equal(selection.products[0].delivery_reliability,null);
      assert.equal(calls,0);
      assert.equal((await api('/catalog/search')).status,422);
    });
    const quoteBody = () => ({requestedDate:'2026-11-16',products:['460000'],selection_ids:[selection.selection_id]});
    await t.test('cannot query upstream without a matching static search',async () => {
      assert.equal((await api('/api/price',{...quoteBody(),products:['460001']})).status,422);
      assert.equal((await api('/api/availability',quoteBody(),'other-user')).status,422);
      assert.equal(calls,0);
      assert.equal((await api('/api/price',quoteBody())).status,200);
      const result=await api('/quotes',quoteBody()); assert.equal(result.status,201); quote=result.body;
      assert.equal(quote.requested_date,'2026-11-16');
      assert.equal(quote.items[0].unit_price,2.5); assert.equal(quote.mocked,true);
    });
    const orderBody = (extra={}) => ({quote_id:quote.id,items:[{productId:'460000',quantity:1}],...extra});
    await t.test('valid normal order approves and concurrent retries create one order',async () => {
      const key=randomUUID(); const results=await Promise.all([api('/orders',orderBody(),user,key),api('/orders',orderBody(),user,key)]);
      assert.equal(results[0].status,201); assert.equal(results[0].body.status,'APPROVED');
      assert.equal(results[0].body.id,results[1].body.id); assert.equal(Number(results[0].body.total_cents),250);
      assert.equal((await api('/orders',orderBody({force_flag:true}),user,key)).status,409);
    });
    await t.test('flagged order is queued, isolated by user, and decided once',async () => {
      const result=await api('/orders',orderBody({force_flag:true})); const order=result.body;
      assert.equal(order.status,'PENDING_APPROVAL');
      assert.ok((await api('/orders')).body.some(o => o.id===order.id));
      assert.equal((await api(`/orders/${order.id}/approve`,{},'other-user')).status,404);
      const decisions=await Promise.all([api(`/orders/${order.id}/approve`,{}),api(`/orders/${order.id}/reject`,{})]);
      assert.deepEqual(decisions.map(d => d.status).sort(),[200,409]);
      const final=(await api(`/orders/${order.id}`)).body;
      const action=final.status==='APPROVED'?'approve':'reject';
      assert.equal((await api(`/orders/${order.id}/${action}`,{})).status,200);
      const events=await pool.query('SELECT * FROM order_events WHERE order_id=$1',[order.id]);
      assert.equal(events.rowCount,2);
    });
    await t.test('bulk rule flags orders and rejection is terminal',async () => {
      const result=await api('/orders',orderBody({items:[{productId:'460000',quantity:21}]}));
      assert.equal(result.body.status,'PENDING_APPROVAL'); assert.match(result.body.flag_reason,/20/);
      assert.equal((await api(`/orders/${result.body.id}/reject`,{})).body.status,'REJECTED');
      assert.equal((await api(`/orders/${result.body.id}/approve`,{})).status,409);
    });
    await t.test('rejects tampered prices, duplicate lines, invalid lots, and foreign quotes',async () => {
      for (const input of [orderBody({total_cents:1}),orderBody({items:[{productId:'460000',quantity:0.001}]}),orderBody({items:[{productId:'460001',quantity:1}]}),orderBody({items:[{productId:'460000',quantity:1},{productId:'460000',quantity:1}]})]) {
        assert.equal((await api('/orders',input)).status,422);
      }
      assert.equal((await api('/orders',orderBody(),'other-user')).status,409);
    });
    await t.test('unavailable and unpriced products cannot be ordered',async () => {
      const changed=structuredClone(quote.items); changed[0].orderable=false;
      await pool.query('UPDATE quotes SET items=$1 WHERE id=$2',[JSON.stringify(changed),quote.id]);
      assert.equal((await api('/orders',orderBody())).status,422);
      await pool.query('UPDATE quotes SET items=$1 WHERE id=$2',[JSON.stringify(quote.items),quote.id]);
    });
    await t.test('expired quotes cannot be approved, but can be rejected',async () => {
      const order=(await api('/orders',orderBody({force_flag:true}))).body;
      await pool.query("UPDATE quotes SET expires_at=now()-interval '1 second' WHERE id=$1",[quote.id]);
      assert.equal((await api(`/orders/${order.id}/approve`,{})).status,409);
      assert.equal((await api(`/orders/${order.id}/reject`,{})).status,200);
      assert.equal((await api('/orders',orderBody())).status,409);
    });
    await t.test('agent adapter searches before constructing a model-selected cart',async () => {
      let modelCalls=0;
      const cart=await recipeCart('salmon soup',async path => (await api(path)).body,async () => {
        modelCalls++;
        return modelCalls===1 ? {ingredients:[{query:'potato'}]} : {items:[{productId:'460000',quantity:1}]};
      });
      assert.equal(cart.items[0].productId,'460000'); assert.equal(cart.selection_ids.length,1);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.query('DELETE FROM order_events WHERE user_id=$1',[user]);
    await pool.query('DELETE FROM orders WHERE user_id=$1',[user]);
    await pool.query('DELETE FROM quotes WHERE user_id=$1',[user]);
    await pool.query('DELETE FROM selections WHERE user_id=$1',[user]);
    await pool.end();
  }
});
