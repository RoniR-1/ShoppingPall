/** A scorer implements score(order) and returns a safe integer. */
export class PlaceholderSuspicionScorer {
  score(_order) { return 0; }
}

export const OrderStatus = Object.freeze({ APPROVED: 'APPROVED', PENDING_REVIEW: 'PENDING_APPROVAL' });

export class OrderScreeningService {
  constructor({ scorer = new PlaceholderSuspicionScorer(), threshold = Number(process.env.SUSPICION_THRESHOLD ?? 0) } = {}) {
    if (typeof scorer?.score !== 'function') throw new TypeError('scorer must implement score(order)');
    this.scorer = scorer;
    this.setThreshold(threshold);
  }
  setThreshold(threshold) {
    if (!Number.isSafeInteger(threshold)) throw new TypeError('threshold must be a safe integer');
    this.threshold = threshold;
  }
  evaluate(order) {
    const score = this.scorer.score(order);
    if (!Number.isSafeInteger(score)) throw new TypeError('scorer must return a safe integer');
    return { score, threshold: this.threshold, status: score > this.threshold ? OrderStatus.PENDING_REVIEW : OrderStatus.APPROVED };
  }
}

