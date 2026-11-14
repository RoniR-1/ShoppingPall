export class SuspicionScorer {
  score(order) {
    if (order.force_flag) return {score:85,reason:'Demo review flag'};
    if (order.lines.length > 20 || order.lines.reduce((n,l)=>n+l.quantity,0)>100) return {score:80,reason:'Unusually large request'};
    return {score:10,reason:'Routine procurement quantities'};
  }
}
export function route(order, scorer = new SuspicionScorer(), threshold = 50) {
  const result = scorer.score(order);
  if (!Number.isSafeInteger(result.score) || !Number.isSafeInteger(threshold)) throw Error('Invalid scoring configuration');
  return {...result,threshold,status: result.score>threshold || order.incomplete ? 'PENDING_APPROVAL':'APPROVED'};
}
