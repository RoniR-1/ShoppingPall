import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DemoStore} from '../src/web-demo/demo-store.js';
import {projectAuditEvent,verifyAuditChain,auditCsv} from '../src/audit.js';

function order(id,user='buyer') {return {id,user_id:user,status:'PENDING_APPROVAL',quote_expires_at:new Date(Date.now()+60000).toISOString(),quote_requested_date:'2026-11-16',steps:[],threshold:25,score:30,checks:[{rule:'budget',status:'flag',text:'private budget note'}],supplier_claims:[{price:{products:[{productId:'demo-eggs',priceWithTax:{value:2.5}}]},availability:{products:[{productId:'demo-eggs',scheduleLines:[{availableAmount:100}]}]}}],items:[{productId:'demo-eggs',quantity:2,price:2.5,available:100}],total:5};}

test('portal audit records quote, escalation and idempotent human commitment separately from traces',()=>{
 const d=new DemoStore(),o=order('one');d.save(o);d.save({...o,steps:['trace change']});
 assert.deepEqual(d.audit('buyer','one').events.map(e=>e.event_type),['QUOTE_VERIFIED','ESCALATED_FOR_APPROVAL']);
 assert.throws(()=>d.audit('other','one'),/not found/);
 d.decide({id:'one',user_id:'buyer',action:'approve',human:true});d.decide({id:'one',user_id:'buyer',action:'approve',human:true});
 const result=d.audit('buyer','one');assert.equal(result.storage,'memory');assert.equal(result.verification.valid,true);
 assert.deepEqual(result.events.map(e=>e.event_type),['QUOTE_VERIFIED','ESCALATED_FOR_APPROVAL','GUARDRAIL_PASSED','HUMAN_APPROVED','ORDER_COMMITTED']);
 assert.equal(result.events.at(-1).commercial_commitment.supplier_order_submitted,false);
 const wholesale=result.events.map(e=>projectAuditEvent(e,'wholesaler'));assert.ok(!JSON.stringify(wholesale).includes('private budget note'));assert.ok(!auditCsv(wholesale).includes('private budget note'));
 const altered=structuredClone(result.events);altered[0].commercial_commitment.total_eur=999;assert.equal(verifyAuditChain(altered).valid,false);
 d.reset('low');assert.equal(d.audit('buyer','one').events.length,5);
});

test('portal rejection and failed checkout do not produce a commitment',()=>{
 const d=new DemoStore();let o=order('failed');o.quote_expires_at='2000-01-01T00:00:00Z';d.save(o);
 assert.throws(()=>d.decide({id:o.id,user_id:'buyer',action:'approve',human:true}),/expired/);
 d.failedDecision({id:o.id,user_id:'buyer',action:'approve'},Error('Quote expired'));
 d.decide({id:o.id,user_id:'buyer',action:'reject',human:true});
 const types=d.audit('buyer',o.id).events.map(e=>e.event_type);
 assert.ok(types.includes('GUARDRAIL_FAILED'));assert.ok(types.includes('HUMAN_REJECTED'));assert.ok(!types.includes('ORDER_COMMITTED'));
});
