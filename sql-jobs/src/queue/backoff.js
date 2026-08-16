export function backoffMs(attempts, { base = 200, cap = 30000, random = Math.random } = {}) {
  const capped = Math.min(cap, base * 2 ** attempts)
  return random() * capped
}
