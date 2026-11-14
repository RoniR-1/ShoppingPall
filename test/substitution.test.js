import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderItems, scoreOrder } from '../src/orders.js';
import { orderRequest } from '../src/contracts.js';

function product(productId, overrides = {}) {
  return {
    productId, id:productId, name:productId === 'original' ? 'Original item' : 'Substitute item',
    category:'category-1', sales_unit:'EA', allowed_lot_size:1, unit_price:2,
    availableAmount:20, availableDate:'2026-11-16', orderable:true,
    logistic_model:'Terminal', price:{error:false}, availability:{salesBlock:false,scheduleLines:[{}]},
    raw:{ substitutions:[], synkkaData:{ keyIngredients:[{value:'same ingredient list',language:'en'}],
      nutritionalContent:[{id:'ENER-KJO',value:100}], unitConversions:[{netWeight:{value:100}}] } },
    ...overrides
  };
}

const policy = { hard_spend_limit:1000, weekly_spend_limit:5000, excluded_allergens:[] };

test('catalog substitution scoring and mandate diagnostics', async t => {
  await t.test('mapped pack or nutrition shift gets 30 points and the deterministic prompt', () => {
    const original = product('original', { raw:{ substitutions:[{product:'original',substituteProduct:'substitute'}],
      synkkaData:{keyIngredients:[{value:'same ingredient list',language:'en'}],nutritionalContent:[{id:'ENER-KJO',value:100}],unitConversions:[{netWeight:{value:100}}]} } });
    const substitute = product('substitute', { raw:{substitutions:[],synkkaData:{
      keyIngredients:[{value:'same ingredient list',language:'en'}], nutritionalContent:[{id:'ENER-KJO',value:160}],
      unitConversions:[{netWeight:{value:100}}]
    }} });
    const cart = buildOrderItems([{productId:'substitute',quantity:1,substitutedFrom:'original'}], {items:[original,substitute]});
    const risk = scoreOrder(cart,{policy,history:[]});
    console.log(`[substitution-debug] mapped=${cart[0].substitution_mapped}, risk=${cart[0].substitutionRisk}, penalty=${risk.penalties.substitution}, question=${risk.questions.find(q=>q.rule==='substitution')?.message}`);
    assert.equal(cart[0].substitution_mapped,true);
    assert.equal(cart[0].substitutionRisk,'mapped_pack_or_nutrition_shift');
    assert.equal(risk.penalties.substitution,30);
    assert.match(risk.questions.find(q=>q.rule==='substitution').message,/Substitute item instead of Original item/);
    assert.deepEqual(risk.questions.find(q=>q.rule==='substitution').alternatives,['keep_original','cancel']);
  });

  await t.test('mapped ingredient shift gets 45 points', () => {
    const original=product('original',{raw:{substitutions:[{product:'original',substituteProduct:'substitute'}],
      synkkaData:{keyIngredients:[{value:'milk',language:'en'}],nutritionalContent:[],unitConversions:[]} }});
    const substitute=product('substitute',{raw:{substitutions:[],
      synkkaData:{keyIngredients:[{value:'soy',language:'en'}],nutritionalContent:[],unitConversions:[]} }});
    const [item]=buildOrderItems([{productId:'substitute',quantity:1,substitutedFrom:'original'}],{items:[original,substitute]});
    const risk=scoreOrder([item],{policy,history:[]});
    console.log(`[substitution-debug] mapped ingredient shift penalty=${risk.penalties.substitution}`);
    assert.equal(item.substitutionRisk,'ingredient_shift');
    assert.equal(risk.penalties.substitution,45);
  });

  await t.test('unmapped swap gets 45 points and offers safe alternatives', () => {
    const original=product('original');
    const substitute=product('substitute');
    const [item]=buildOrderItems([{productId:'substitute',quantity:1,substitutedFrom:'original'}],{items:[original,substitute]});
    const risk=scoreOrder([item],{policy,history:[]});
    const question=risk.questions.find(q=>q.rule==='substitution');
    console.log(`[substitution-debug] mapped=${item.substitution_mapped}, penalty=${risk.penalties.substitution}, alternatives=${question.alternatives}`);
    assert.equal(item.substitutionRisk,'unmapped');
    assert.equal(risk.penalties.substitution,45);
    assert.deepEqual(question.alternatives,['keep_original','cancel']);
  });

  await t.test('order request accepts explicit original-product metadata', () => {
    const parsed=orderRequest.parse({quote_id:'00000000-0000-4000-8000-000000000001',items:[
      {productId:'substitute',quantity:1,substitutedFrom:'original'}
    ]});
    assert.equal(parsed.items[0].substitutedFrom,'original');
  });
});
