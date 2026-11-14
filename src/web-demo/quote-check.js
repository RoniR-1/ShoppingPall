// A quoted cutoff must remain unambiguous and in the future at approval time.
export function assertQuoteCutoffs(items, now = Date.now()) {
  for (const item of items) {
    const cutoff = item.closing_time;
    if (cutoff == null) continue;
    if (typeof cutoff !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(cutoff) || !Number.isFinite(Date.parse(cutoff)) || Date.parse(cutoff) <= now) {
      throw Error(`Order cutoff passed or is ambiguous for ${item.name || item.productId}; submit a new request for a fresh quote`);
    }
  }
}

export function allocateAvailable(desired, available, lot) {
  if (![desired, available, lot].every(Number.isFinite) || desired <= 0 || available <= 0 || lot <= 0) return 0;
  let steps = Math.floor(Math.min(desired, available) / lot);
  let quantity = steps * lot;
  while (steps > 0 && (quantity > desired || quantity > available)) quantity = --steps * lot;
  return quantity;
}
