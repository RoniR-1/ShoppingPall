import {describe,it,expect} from 'vitest';
import {route,SuspicionScorer} from '../src/web-demo/policy.js';
describe('Gatekeeper',()=>{
 for(const [score,status] of [[49,'APPROVED'],[50,'APPROVED'],[51,'PENDING_APPROVAL']])it(`score ${score}`,()=>expect(route({},{score:()=>({score,reason:'test'})},50).status).toBe(status));
 it('runtime threshold changes routing',()=>{const scorer={score:()=>({score:50,reason:'test'})};expect(route({},scorer,49).status).toBe('PENDING_APPROVAL');expect(route({},scorer,50).status).toBe('APPROVED');});
 it('shortfall always requires review',()=>expect(route({incomplete:true},{score:()=>({score:0,reason:'test'})},50).status).toBe('PENDING_APPROVAL'));
 it('a stated budget overrun always requires human review',()=>{
  const result=route({budget_overrun:true,budget_limit:10,total:17.5,items:[{lineIndex:0,productId:'eggs',quantity:1,price:17.5}]},undefined,200);
  expect(result.status).toBe('PENDING_APPROVAL');
  expect(result.questions.some(q=>q.rule==='budgetOverrun'&&q.message.includes('€17.50'))).toBe(true);
 });
 it('demo flag is high risk',()=>expect(new SuspicionScorer().score({force_flag:true}).score).toBe(85));
 it('auto-approves regular patterns without human interaction while flagging unfamiliar or spiked orders',()=>{
  const regular=route({
   lines:[{quantity:1,query:'apple'}],
   items:[{productId:'460895',quantity:1,price:2.5,bought_count:2,human_approved_count:1,prior_max_qty:1,allergen_safe:true,reliability:1,carbon:0.165}],
   total:2.5,
   buyerHistory:{spendCap:200}
  });
  expect(regular.score).toBe(5);
  expect(regular.status).toBe('APPROVED');

  const firstTime=route({
   lines:[{quantity:2,query:'milk'}],
   items:[{productId:'100',quantity:2,price:3,bought_count:0,human_approved_count:0,prior_max_qty:0,allergen_safe:true,reliability:0.99,carbon:1.1}],
   total:6,
   buyerHistory:{spendCap:200}
  });
  expect(firstTime.score).toBeGreaterThan(25);
  expect(firstTime.status).toBe('PENDING_APPROVAL');

  const hugeSpike=route({
   lines:[{quantity:20,query:'apple'}],
   items:[{productId:'460895',quantity:20,price:25,bought_count:2,human_approved_count:1,prior_max_qty:1,prior_min_qty:1,allergen_safe:true,reliability:1,carbon:0.165}],
   total:500,
   buyerHistory:{spendCap:200,minOrderTotal:2.5}
  },undefined,150);
  expect(hugeSpike.score).toBeGreaterThan(150);
  expect(hugeSpike.status).toBe('PENDING_APPROVAL');

  const tooLittle=route({
   lines:[{quantity:2,query:'apple'}],
   items:[{lineIndex:0,productId:'460895',name:'Apple Golden',quantity:2,price:2.5,bought_count:3,human_approved_count:1,prior_max_qty:12,prior_min_qty:10,allergen_safe:true,reliability:1,carbon:0.165,alternatives:[{productId:'460891',name:'Apple Red',unit:'BAG',price:2.1,available:50}]}],
   total:5,
   buyerHistory:{spendCap:200,minOrderTotal:25}
  });
  expect(tooLittle.score).toBeGreaterThan(25);
  expect(tooLittle.reason).toContain('Unusually small quantity vs prior orders');
  expect(tooLittle.status).toBe('PENDING_APPROVAL');
  expect(tooLittle.questions.length).toBeGreaterThanOrEqual(1);
  expect(tooLittle.questions[0].alternatives[0].productId).toBe('460891');
 });
});

import {directLines,substitutionQuery} from '../src/web-demo/text.js';
it('parses conversational shopping lists without replacing products',()=>expect(directLines('i want 5 beers and 2 chocolate bars')).toEqual([{query:'beer',quantity:5},{query:'chocolate',quantity:2}]));
it('only relaxes a supported food style',()=>{expect(substitutionQuery('extra dark chocolate')).toBe('chocolate');expect(substitutionQuery('imaginary potato salad')).toBeNull();expect(substitutionQuery('vegan dark chocolate')).toBeNull();expect(substitutionQuery('beer')).toBeNull();});

import {sourceContext,sourceName} from '../src/web-demo/sources.js';
it('keeps concurrent database sources isolated',async()=>{
 const seen=await Promise.all(['demo','real'].map(source=>sourceContext.run(source,async()=>{await new Promise(resolve=>setTimeout(resolve,5));return sourceName();})));
 expect(seen).toEqual(['demo','real']);expect(sourceName()).toBe('real');
});

import {DemoStore} from '../src/web-demo/demo-store.js';
it('demo is ready with seven products without PostgreSQL',()=>{const d=new DemoStore();expect(d.overview().products).toHaveLength(7);expect(d.search('beer')).toHaveLength(2);expect(d.overview().products[0].substitutions).toHaveLength(1);});
it('demo checkout is atomic and repeated approval does not debit twice',()=>{const d=new DemoStore();d.save({id:'a',user_id:'u',status:'PENDING_APPROVAL',quote_expires_at:new Date(Date.now()+900000).toISOString(),steps:[],items:[{productId:'demo-beer',quantity:2}]});expect(()=>d.decide({id:'a',user_id:'u',action:'approve'})).toThrow('Human approval');d.decide({id:'a',user_id:'u',action:'approve',human:true});d.decide({id:'a',user_id:'u',action:'approve',human:true});expect(d.stock.get('demo-beer')).toBe(98);d.save({id:'b',user_id:'u',status:'PENDING_APPROVAL',quote_expires_at:new Date(Date.now()+900000).toISOString(),steps:[],items:[{productId:'demo-beer',quantity:1},{productId:'demo-eggs',quantity:101}]});expect(()=>d.decide({id:'b',user_id:'u',action:'approve',human:true})).toThrow('Stock changed');expect(d.stock.get('demo-beer')).toBe(98);});
it('keeps buyers and risk thresholds independent and rejects duplicate creation',()=>{
 const d=new DemoStore();
 expect(d.getBuyer('demo-buyer').threshold).toBe(25);
 expect(d.getBuyer('ghost-buyer').threshold).toBe(25);
 expect(d.listBuyers().map(b=>b.user_id)).toEqual(['demo-buyer']);
 const alice=d.upsertBuyer('alice',12.3456,{createOnly:true});
 expect(alice).toEqual({user_id:'alice',threshold:12.346});
 expect(()=>d.upsertBuyer('alice',99,{createOnly:true})).toThrow('already exists');
 d.upsertBuyer('bob',60,{createOnly:true});
 d.upsertBuyer('alice',40);
 expect(d.getBuyer('alice').threshold).toBe(40);
 expect(d.getBuyer('bob').threshold).toBe(60);
 expect(d.getBuyer('demo-buyer').threshold).toBe(25);
 expect(d.listBuyers().map(b=>b.user_id)).toEqual(['demo-buyer','alice','bob']);
});
it('tracks per-buyer item history in DemoStore search and distinct question IDs on split lines',()=>{
 const d=new DemoStore();
 d.save({id:'o1',user_id:'alice',status:'PENDING_APPROVAL',quote_expires_at:new Date(Date.now()+900000).toISOString(),steps:[],items:[{productId:'demo-beer',quantity:4}]});
 d.decide({id:'o1',user_id:'alice',action:'approve',human:true});
 const [lager]=d.search('lager beer','alice');
 expect(lager.bought_count).toBe(1);
 expect(lager.human_approved_count).toBe(1);
 expect(lager.prior_max_qty).toBe(4);
 expect(lager.prior_min_qty).toBe(4);
 const split=new SuspicionScorer().score({
  lines:[{quantity:10,query:'beer'}],
  items:[
   {lineIndex:0,productId:'demo-beer',name:'Lager beer',quantity:5,price:2.5},
   {lineIndex:0,productId:'demo-dark-beer',name:'Dark beer',quantity:5,price:2.5}
  ]
 });
 const ids=split.questions.map(q=>q.id);
 expect(new Set(ids).size).toBe(ids.length);
});

import {closestProducts} from '../src/web-demo/matches.js';
it('suggests chocolates and typos without unrelated food',()=>{const d=new DemoStore();expect(closestProducts('chocolates',d.products).map(p=>p.id)).toEqual(['demo-dark-chocolate','demo-milk-chocolate']);expect(closestProducts('choclate',d.products)).toHaveLength(2);expect(closestProducts('vegan chocolate',d.products)).toEqual([]);expect(closestProducts('salmon',d.products)).toEqual([]);});
it('sets humane question metadata with manual quantity adjustment and disables substitutes on volume/quantity rules',()=>{
 const s=new SuspicionScorer();
 const spikeScore=s.score({
  lines:[{quantity:12,query:'oat milk'}],
  items:[{lineIndex:0,productId:'demo-oat-milk',name:'Oat milk',quantity:12,price:2,unit:'L',lot:1,bought_count:2,human_approved_count:1,prior_max_qty:4,prior_min_qty:4}]
 });
 const spikeQ=spikeScore.questions.find(q=>q.rule==='quantitySpike');
 expect(spikeQ).toBeTruthy();
 expect(spikeQ.allowQuantityEdit).toBe(true);
 expect(spikeQ.allowSubstitution).toBe(false);
 expect(spikeQ.currentQty).toBe(12);
 expect(spikeQ.suggestedQty).toBe(4);
 const dropScore=s.score({
  lines:[{quantity:1,query:'oat milk'}],
  items:[{lineIndex:0,productId:'demo-oat-milk',name:'Oat milk',quantity:1,price:2,unit:'L',lot:1,bought_count:2,human_approved_count:1,prior_max_qty:4,prior_min_qty:4}]
 });
 const dropQ=dropScore.questions.find(q=>q.rule==='quantityDrop');
 expect(dropQ).toBeTruthy();
 expect(dropQ.allowQuantityEdit).toBe(true);
 expect(dropQ.allowSubstitution).toBe(false);
 expect(dropQ.suggestedQty).toBe(4);
 const unfamScore=s.score({
  lines:[{quantity:5,query:'pears'}],
  items:[{lineIndex:0,productId:'demo-pears',name:'Pears',quantity:5,price:2.5,unit:'BAG',lot:1,bought_count:0,human_approved_count:0}]
 });
 const unfamQ=unfamScore.questions.find(q=>q.rule==='unfamiliarItem');
 expect(unfamQ).toBeTruthy();
 expect(unfamQ.allowQuantityEdit).toBe(true);
 expect(unfamQ.allowSubstitution).toBe(true);
});
it('does not flag generic requests like pear as substitutions and avoids duplicate unfamiliar+substitution questions',()=>{
 const s=new SuspicionScorer();
 const genericPear=s.score({
  lines:[{quantity:50,query:'pear',requested:'50 × pear'}],
  items:[{lineIndex:0,productId:'462574',name:'PEAR SUOMI KG',quantity:50,price:2.5,unit:'KG',lot:1,bought_count:1,human_approved_count:1,prior_max_qty:50,prior_min_qty:50,requested:'50 × pear',substitution:true}]
 });
 expect(genericPear.reason).not.toContain('Product substitution');
 expect(genericPear.questions.some(q=>q.rule==='substitution')).toBe(false);

 const specificBrand=s.score({
  lines:[{quantity:4,query:'conference pear',requested:'4 conference pear'}],
  items:[{lineIndex:0,productId:'462574',name:'PEAR SUOMI KG',quantity:4,price:2.5,unit:'KG',lot:1,bought_count:0,human_approved_count:0,requested:'4 conference pear'}]
 });
 expect(specificBrand.reason).toContain('Product substitution');
 expect(specificBrand.questions).toHaveLength(1);
 expect(specificBrand.questions[0].message).toContain('conference');
});

it('demo blocks excluded allergens even with human approval',()=>{const d=new DemoStore();d.save({id:'unsafe',user_id:'u',status:'PENDING_APPROVAL',quote_expires_at:new Date(Date.now()+900000).toISOString(),steps:[],items:[{productId:'demo-milk',quantity:1,allergen_safe:false}]});expect(()=>d.decide({id:'unsafe',user_id:'u',action:'approve',human:true})).toThrow('excluded allergens');expect(d.stock.get('demo-milk')).toBe(100);});
it('expired quotes never debit inventory',()=>{const d=new DemoStore();d.save({id:'expired',user_id:'u',status:'PENDING_APPROVAL',quote_expires_at:new Date(Date.now()-1).toISOString(),steps:[],items:[{productId:'demo-eggs',quantity:1}]});expect(()=>d.decide({id:'expired',user_id:'u',action:'approve',human:true})).toThrow('Quote expired');expect(d.stock.get('demo-eggs')).toBe(100);expect(d.list('u')[0].status).toBe('PENDING_APPROVAL');});
it('replacement proposal and rejection occur together',()=>{const d=new DemoStore();const old={id:'original',user_id:'u',status:'PENDING_APPROVAL',steps:[],items:[]};d.save(old);const proposal={id:'replacement',user_id:'u',status:'PENDING_APPROVAL',steps:[],items:[]};expect(()=>d.replace({id:'original',user_id:'wrong',replacement:proposal})).toThrow();expect(d.list('u')).toHaveLength(1);d.replace({id:'original',user_id:'u',replacement:proposal});expect(d.list('u').find(o=>o.id==='original').status).toBe('REJECTED');expect(d.list('u').find(o=>o.id==='replacement').status).toBe('PENDING_APPROVAL');});
it('a quoted cutoff must remain open and include a timezone at approval',()=>{const d=new DemoStore();const make=(id,closing_time)=>({id,user_id:'u',status:'PENDING_APPROVAL',quote_expires_at:new Date(Date.now()+900000).toISOString(),steps:[],items:[{productId:'demo-eggs',quantity:1,closing_time}]});for(const [id,cutoff] of [['closed','2001-01-01T00:00:00Z'],['ambiguous','2099-01-01T00:00:00']]){d.save(make(id,cutoff));expect(()=>d.decide({id,user_id:'u',action:'approve',human:true})).toThrow('cutoff');}expect(d.stock.get('demo-eggs')).toBe(100);d.save(make('open','2099-01-01T00:00:00Z'));d.decide({id:'open',user_id:'u',action:'approve',human:true});expect(d.stock.get('demo-eggs')).toBe(99);});

import {callGeminiJSON} from '../src/web-demo/luna.js';
it('Luna rejects truncated, malformed and rate-limited responses without retries',async()=>{const env={LUNA_BASE_URL:'https://luna.example',LUNA_API_KEY:'secret',LUNA_MODEL:'test-model'};let calls=0;const run=(status,body)=>callGeminiJSON('system','user',{env,fetchImpl:async()=>{calls++;return new Response(body,{status});}});await expect(run(200,JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"lines":[]}'}}]}))).rejects.toMatchObject({code:'AI_TRUNCATED'});await expect(run(200,JSON.stringify({choices:[{message:{content:{bad:true}}}]}))).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'});await expect(run(429,JSON.stringify({error:{message:'quota'}}))).rejects.toMatchObject({status:429,code:'AI_RATE_LIMITED'});await expect(run(200,'not json')).rejects.toMatchObject({code:'AI_INVALID_RESPONSE'});expect(calls).toBe(4);});
it('Luna reports unavailable transport and missing configuration',async()=>{await expect(callGeminiJSON('s','u',{env:{},fetchImpl:()=>{throw Error('unreachable');}})).rejects.toMatchObject({code:'AI_NOT_CONFIGURED'});await expect(callGeminiJSON('s','u',{env:{LUNA_BASE_URL:'https://luna.example',LUNA_API_KEY:'secret',LUNA_MODEL:'test-model'},fetchImpl:()=>{throw Error('timeout');}})).rejects.toMatchObject({status:502,code:'AI_UNAVAILABLE'});});
it('Luna preserves a rate limit even when the response body is empty or plain text',async()=>{const env={LUNA_BASE_URL:'https://luna.example',LUNA_API_KEY:'secret',LUNA_MODEL:'test-model'};for(const body of ['', 'rate limited']){let calls=0;await expect(callGeminiJSON('s','u',{env,fetchImpl:async()=>{calls++;return new Response(body,{status:429});}})).rejects.toMatchObject({status:429,code:'AI_RATE_LIMITED'});expect(calls).toBe(1);}});
import {allocateAvailable} from '../src/web-demo/quote-check.js';
it('allocation never rounds tiny or fractional stock up to the requested quantity',()=>{expect(allocateAvailable(0.001,0.0006,0.001)).toBe(0);expect(allocateAvailable(1,0.9999,1)).toBe(0);expect(allocateAvailable(2,1.9999,1)).toBe(1);expect(allocateAvailable(1,1,0)).toBe(0);});
it('Luna rejects null success payload and preserves null rate-limit status',async()=>{const env={LUNA_BASE_URL:'https://luna.example',LUNA_API_KEY:'secret',LUNA_MODEL:'test-model'};for(const [status,code] of [[200,'AI_INVALID_RESPONSE'],[429,'AI_RATE_LIMITED']]){let calls=0;await expect(callGeminiJSON('s','u',{env,fetchImpl:async()=>{calls++;return new Response('null',{status});}})).rejects.toMatchObject({status:status===200?502:429,code});expect(calls).toBe(1);}});
