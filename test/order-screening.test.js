import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { OrderScreeningService, OrderStatus } from '../src/order-screening.js';

const show = (label, value) => console.log(`  ${label}: ${inspect(value, { depth: null, colors: false })}`);
const describeCase = (intent, input) => {
  console.log(`\n--- ${intent} ---`);
  show('Input', input);
};

for (const [score, status] of [[9, OrderStatus.APPROVED], [10, OrderStatus.APPROVED], [11, OrderStatus.PENDING_REVIEW]]) {
  test(`score ${score} routes to ${status}`, () => {
    const order = { id: 'order-1', items: [{ quantity: 2 }] };
    describeCase('Check the decision below, at, and above the threshold', { order, score, threshold: 10, expectedStatus: status });
    let received;
    const service = new OrderScreeningService({ threshold: 10, scorer: { score(value) { received = value; return score; } } });
    const result = service.evaluate(order);
    show('Output', result);
    assert.deepEqual(result, { score, threshold: 10, status });
    assert.strictEqual(received, order);
  });
}

test('threshold changes apply to subsequent orders', () => {
  describeCase('Check that threshold changes affect later evaluations and invalid changes are rejected', { order: {}, score: 11, thresholds: [10, 11, NaN] });
  const service = new OrderScreeningService({ threshold: 10, scorer: { score: () => 11 } });
  const before = service.evaluate({});
  assert.equal(before.status, OrderStatus.PENDING_REVIEW);
  service.setThreshold(11);
  const after = service.evaluate({});
  assert.equal(after.status, OrderStatus.APPROVED);
  assert.throws(() => service.setThreshold(NaN), /threshold/);
  const afterInvalid = service.evaluate({});
  show('Output', { before, after, invalidThreshold: 'rejected', afterInvalid });
  assert.equal(afterInvalid.status, OrderStatus.APPROVED);
});

test('placeholder approves and invalid scores fail closed', () => {
  const invalidScores = [NaN, Infinity, 1.5, '1', undefined];
  describeCase('Check the placeholder decision and reject invalid scorer outputs and implementations', { order: {}, invalidScores });
  const placeholder = new OrderScreeningService().evaluate({});
  assert.equal(placeholder.status, OrderStatus.APPROVED);
  for (const score of invalidScores) {
    assert.throws(() => new OrderScreeningService({ scorer: { score: () => score } }).evaluate({}), /safe integer/);
  }
  assert.throws(() => new OrderScreeningService({ scorer: {} }), /scorer/);
  show('Output', { placeholder, invalidScores: 'all rejected', invalidScorer: 'rejected' });
});

test('scorer exceptions propagate instead of approving', () => {
  const service = new OrderScreeningService({ scorer: { score() { throw new Error('scorer unavailable'); } } });
  assert.throws(() => service.evaluate({}), /scorer unavailable/);
});
