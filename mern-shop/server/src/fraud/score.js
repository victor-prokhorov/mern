export const THRESHOLDS = { review: 30, deny: 70 }

export function score(signals) {
  const total = signals.reduce((sum, signal) => sum + (signal.triggered ? signal.weight : 0), 0)
  const reasons = signals.filter((signal) => signal.triggered).map((signal) => signal.code)
  let decision = 'allow'
  if (total >= THRESHOLDS.deny) decision = 'deny'
  else if (total >= THRESHOLDS.review) decision = 'review'
  return { score: total, decision, reasons }
}
