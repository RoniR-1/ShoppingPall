import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreOrder } from '../src/orders.js';

const policy = { hard_spend_limit: 1000, weekly_spend_limit: 5000 };
const baseItem = { productId: 'sku-1', category: 'cat-1', unit_price: 2.5,
  quantity: 1, availableDate: '2026-11-16', requestedDate: '2026-11-16' };

test('risk scoring diagnostics', async t => {
  await t.test('empty baseline uses 25% of hard limit and scores spend above dynamic cap', t => {
    const result = scoreOrder([{ ...baseItem, quantity: 120 }], { policy, history: [] });
    console.log(`[risk-debug] empty W10: max_spend_cap=${result.max_spend_cap}, cart_total=${result.cart_total}, budget_penalty=${result.penalties.budgetOverrun}, score=${result.score}, decision=${result.decision}`);
    assert.equal(result.max_spend_cap, 287.5);
    assert.equal(result.cart_total, 300);
    assert.ok(result.penalties.budgetOverrun > 30);
    assert.equal(result.decision, 'REQUIRES_INTERVENTION');
  });

  await t.test('routine W10 drives SKU spike and recurring staple calculations', t => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      routine: true,
      exclude_from_baseline: false,
      total_cents: 10000,
      created_at: new Date('2026-11-14T12:00:00Z'),
      items: index < 5 ? [{ productId: 'sku-1', category: 'cat-1', quantity: 10 }] : []
    }));
    const staple = scoreOrder([{ ...baseItem, quantity: 11 }], { policy, history });
    console.log(`[risk-debug] staple cart: recurring_staple_discount=${staple.discounts.recurringStaple}, quantity_spike=${staple.penalties.quantitySpike}, score=${staple.score}`);
    assert.equal(staple.discounts.recurringStaple, 20);
    assert.equal(staple.penalties.quantitySpike, 0);
    assert.equal(staple.score, 0);

    const spike = scoreOrder([{ ...baseItem, quantity: 13 }], { policy, history });
    console.log(`[risk-debug] spike cart: quantity_spike=${spike.penalties.quantitySpike}, decision=${spike.decision}`);
    assert.ok(Math.abs(spike.penalties.quantitySpike - 29) < 1e-9);
    assert.equal(spike.decision, 'AUTO_APPROVE');
  });

  await t.test('triggered risks produce deterministic questions ordered by risk points', t => {
    const history = [{ routine: true, exclude_from_baseline: false, total_cents: 10000,
      created_at: new Date('2026-11-14T12:00:00Z'), items: [{ productId: 'sku-1', category: 'cat-1', quantity: 10 }] }];
    const result = scoreOrder([{ ...baseItem, name: 'Milk', quantity: 20, availableDate: '2026-11-18', allergens: [] }], { policy, history });
    console.log(`[mandate-debug] questions: ${result.questions.map(q => `${q.rule}(${q.points})`).join(', ')}`);
    assert.deepEqual(result.questions.map(q => q.rule), ['deliveryDelay','quantitySpike']);
    assert.match(result.questions[0].message, /Milk will arrive on 2026-11-18 instead of 2026-11-16/);
    assert.match(result.questions[1].message, /ordering 20 units of Milk \(usual max: 10\)/);
    assert.deepEqual(result.questions[1].alternatives, ['reduce_to_usual_max','remove_item','cancel']);
  });

  await t.test('one risky element routes the entire multi-element order to intervention', t => {
    const history=[{routine:true,exclude_from_baseline:false,total_cents:100000,created_at:new Date('2026-11-14T12:00:00Z'),
      items:[{productId:'sku-1',category:'cat-1',quantity:1}]}];
    const items=[{...baseItem,quantity:2},{...baseItem,productId:'sku-2',name:'Second item',quantity:1}];
    const result=scoreOrder(items,{policy,history});
    console.log(`[risk-debug] multi-element scores=${JSON.stringify(result.element_scores)}; order_decision=${result.decision}`);
    assert.ok(result.element_scores.find(e=>e.product_id==='sku-1').score>=30);
    assert.ok(result.element_scores.find(e=>e.product_id==='sku-2').score<30);
    assert.equal(result.decision,'REQUIRES_INTERVENTION');
  });
});
