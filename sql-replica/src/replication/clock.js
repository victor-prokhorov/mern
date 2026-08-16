export function createClock(startMs = 0) {
  let current = startMs
  return {
    now: () => current,
    set: (ms) => { current = ms },
    advance: (ms) => { current += ms }
  }
}

export const systemClock = {
  now: () => Date.now(),
  set: () => {},
  advance: () => {}
}
