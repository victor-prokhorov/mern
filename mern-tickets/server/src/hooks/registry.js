export function register() {}

export function reset() {}

export async function run(event, payload) {
  return { action: 'continue', payload }
}
