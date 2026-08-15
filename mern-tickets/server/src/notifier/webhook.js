export class WebhookResponseError extends Error {
  constructor(status) {
    super(`webhook responded ${status}`)
    this.status = status
  }
}

export function isWebhookFailure() {
  throw new Error('not implemented')
}

export function createNotifier() {
  throw new Error('not implemented')
}

export async function notify() {
  throw new Error('not implemented')
}

export function stats() {
  throw new Error('not implemented')
}
