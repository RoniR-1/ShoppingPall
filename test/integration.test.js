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
  async function api(path,body,identity=user,key=randomUUID(),method) {
    const response = await fetch(base+path,{method:method || (body === undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-User-Id':identity,'Idempotency-Key':key},...(body === undefined?{}:{body:JSON.stringify(body)})});
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
    await t.test('risk policy is configurable and category blocks are enforced',async () => {
      const defaults=await api('/risk-policy');
      assert.equal(defaults.status,200); assert.equal(defaults.body.hard_spend_limit,1000);
      const policy=await api('/risk-policy',{hard_spend_limit:1000,weekly_spend_limit:5000,blocked_categories:[],excluded_allergens:[]},user,randomUUID(),'PUT');
      assert.equal(policy.status,200); assert.equal(Number(policy.body.hard_spend_limit),1000);
      const blocked=await api('/risk-policy',{blocked_categories:['17301']},user,randomUUID(),'PUT');
      assert.deepEqual(blocked.body.blocked_categories,['17301']);
      assert.equal((await api('/orders',orderBody())).status,422);
      await api('/risk-policy',{blocked_categories:[]},user,randomUUID(),'PUT');
    });
    let routineOrderId;
    await t.test('valid normal order approves and concurrent retries create one order',async t => {
      const key=randomUUID(); const results=await Promise.all([api('/orders',orderBody(),user,key),api('/orders',orderBody(),user,key)]);
      assert.equal(results[0].status,201); assert.equal(results[0].body.status,'APPROVED');
      assert.equal(results[0].body.id,results[1].body.id); assert.equal(Number(results[0].body.total_cents),250);
      routineOrderId=results[0].body.id;
      console.log(`[baseline-debug] created order ${routineOrderId}: routine=${results[0].body.routine}, exclude_from_baseline=${results[0].body.exclude_from_baseline}, risk_score=${results[0].body.risk_score}`);
      assert.equal(results[0].body.routine,true);
      assert.equal(results[0].body.exclude_from_baseline,false);
      assert.equal((await api('/orders',orderBody({force_flag:true}),user,key)).status,409);
    });
    await t.test('approved order can be removed from and restored to the risk baseline',async t => {
      const excluded=await api(`/orders/${routineOrderId}/baseline-exclusion`,{exclude:true});
      console.log(`[baseline-debug] exclude=true response: routine=${excluded.body.routine}, exclude_from_baseline=${excluded.body.exclude_from_baseline}`);
      assert.equal(excluded.status,200); assert.equal(excluded.body.exclude_from_baseline,true);
      const restored=await api(`/orders/${routineOrderId}/baseline-exclusion`,{exclude:false});
      console.log(`[baseline-debug] exclude=false response: routine=${restored.body.routine}, exclude_from_baseline=${restored.body.exclude_from_baseline}`);
      assert.equal(restored.status,200); assert.equal(restored.body.exclude_from_baseline,false);
      assert.equal((await api(`/orders/${routineOrderId}/baseline-exclusion`,{exclude:true},'other-user')).status,404);
      const nonRoutine=await api(`/orders/${routineOrderId}/routine`,{routine:false});
      assert.equal(nonRoutine.body.routine,false);
      const restoredRoutine=await api(`/orders/${routineOrderId}/routine`,{routine:true});
      assert.equal(restoredRoutine.body.routine,true);
    });
    await t.test('flagged order is queued, isolated by user, and decided once',async () => {
      const result=await api('/orders',orderBody({force_flag:true})); const order=result.body;
      assert.equal(order.status,'PENDING_APPROVAL');
      assert.equal((await pool.query('SELECT 1 FROM quote_locks WHERE quote_id=$1 AND order_id=$2',[quote.id,order.id])).rowCount,1);
      assert.equal((await api('/orders',orderBody(),user,randomUUID())).status,409);
      assert.ok((await api('/orders')).body.some(o => o.id===order.id));
      assert.equal((await api(`/orders/${order.id}/approve`,{},'other-user')).status,404);
      const decisions=await Promise.all([api(`/orders/${order.id}/approve`,{}),api(`/orders/${order.id}/reject`,{})]);
      assert.deepEqual(decisions.map(d => d.status).sort(),[200,409]);
      const final=(await api(`/orders/${order.id}`)).body;
      const action=final.status==='APPROVED'?'approve':'reject';
      const decisionResult=await api(`/orders/${order.id}/${action}`,{});
      assert.equal(decisionResult.status,200);
      assert.equal((await pool.query('SELECT 1 FROM quote_locks WHERE order_id=$1',[order.id])).rowCount,0);
      if (final.status==='APPROVED') assert.equal(decisionResult.body.routine,true);
      const events=await pool.query('SELECT * FROM order_events WHERE order_id=$1',[order.id]);
      assert.equal(events.rowCount,2);
      const humanOrder=await api('/orders',orderBody({force_flag:true}),user,randomUUID());
      assert.equal(humanOrder.body.status,'PENDING_APPROVAL');
      const humanApproved=await api(`/orders/${humanOrder.body.id}/approve`,{});
      console.log(`[baseline-debug] human-approved order routine=${humanApproved.body.routine}`);
      assert.equal(humanApproved.body.routine,true);
    });
    await t.test('high-risk order is queued and rejection is terminal',async () => {
      const result=await api('/orders',orderBody({items:[{productId:'460000',quantity:21}]}));
      assert.equal(result.body.status,'PENDING_APPROVAL'); assert.ok(Number(result.body.risk_score) >= 30);
      assert.equal((await api(`/orders/${result.body.id}/reject`,{})).body.status,'REJECTED');
      assert.equal((await api(`/orders/${result.body.id}/approve`,{})).status,409);
    });
    await t.test('real catalog substitution mappings are recognized and scored',async () => {
      const originalSearch=await api('/catalog/search?product_id=460025');
      const substituteSearch=await api('/catalog/search?product_id=460150');
      const subQuote=await api('/quotes',{requestedDate:'2026-11-16',products:['460025','460150'],
        selection_ids:[originalSearch.body.selection_id,substituteSearch.body.selection_id]});
      assert.equal(subQuote.status,201);
      assert.ok(subQuote.body.items.find(i=>i.productId==='460025').raw.substitutions.some(s=>s.product==='460025'&&s.substituteProduct==='460150'));
      const mapped=await api('/orders',{quote_id:subQuote.body.id,items:[{productId:'460150',quantity:1,substitutedFrom:'460025'}]});
      assert.equal(mapped.status,201);
      assert.equal(mapped.body.items[0].substitution_mapped,true);
      console.log(`[substitution-debug] catalog mapping 460025 → 460150 recognized; risk=${mapped.body.risk_details.penalties.substitution}`);

      const other=await api('/catalog/search?product_id=460001');
      const unmappedQuote=await api('/quotes',{requestedDate:'2026-11-16',products:['460000','460001'],
        selection_ids:[selection.selection_id,other.body.selection_id]});
      const unmapped=await api('/orders',{quote_id:unmappedQuote.body.id,items:[{productId:'460001',quantity:1,substitutedFrom:'460000'}]});
      assert.equal(unmapped.status,201); assert.equal(unmapped.body.risk_details.penalties.substitution,45);
      assert.ok(unmapped.body.risk_details.questions.some(q=>q.rule==='substitution'));
    });
    await t.test('mandate no opens alternatives and reducing quantity recalculates the order',async () => {
      const created=await api('/orders',orderBody({items:[{productId:'460000',quantity:21}]}));
      assert.equal(created.status,201); assert.equal(created.body.status,'PENDING_APPROVAL');
      const question=created.body.risk_details.questions.find(q => q.rule==='quantitySpike');
      assert.ok(question,`Expected quantity spike question; got ${JSON.stringify(created.body.risk_details.questions)}`);
      console.log(`[mandate-debug] prompt: ${question.message}; order risk=${created.body.risk_score}`);
      const menu=await api(`/orders/${created.body.id}/mandate`,{question_id:question.id,answer:'no'});
      console.log(`[mandate-debug] no response menu: ${JSON.stringify(menu.body.menu)}`);
      assert.equal(menu.status,200); assert.ok(menu.body.menu.includes('reduce_to_usual_max'));
      const resolved=await api(`/orders/${created.body.id}/mandate`,{
        question_id:question.id,answer:'no',alternative:'reduce_to_usual_max'
      });
      console.log(`[mandate-debug] reduced order: status=${resolved.body.order.status}, quantity=${resolved.body.order.items[0].quantity}, risk=${resolved.body.order.risk_score}`);
      assert.equal(resolved.status,200); assert.equal(resolved.body.order.status,'APPROVED');
      assert.equal(Number(resolved.body.order.items[0].quantity),1);
      assert.ok(Number(resolved.body.order.risk_score)<30);
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
    await pool.query('DELETE FROM buyer_risk_policies WHERE user_id=$1',[user]);
    await pool.end();
  }
});
