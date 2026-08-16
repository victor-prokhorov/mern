import * as sagaRepo from '../repositories/saga.js'
import { backoffMs } from './backoff.js'

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function attemptWithRetry(pool, step, fn, { backoff, sleep }) {
  let attempt = step.attempts
  for (;;) {
    try {
      await fn()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await sagaRepo.recordAttempt(pool, step.id, message)
      attempt += 1
      if (attempt >= step.max_attempts) return { ok: false, error: message }
      await sleep(backoffMs(attempt, backoff))
    }
  }
}

async function runStepWithRetry(pool, sagaId, step, impl, context, opts) {
  const outcome = await attemptWithRetry(pool, step, () => impl.action({ pool, sagaId, context }), opts)
  await sagaRepo.setStepStatus(pool, step.id, outcome.ok ? 'done' : 'failed')
  return outcome
}

async function compensate(pool, sagaId, doneStack, registry, context, opts) {
  await sagaRepo.setSagaStatus(pool, sagaId, 'compensating')
  for (let i = doneStack.length - 1; i >= 0; i--) {
    const step = doneStack[i]
    const impl = registry.get(step.name)
    if (impl && impl.compensate) {
      const outcome = await attemptWithRetry(pool, step, () => impl.compensate({ pool, sagaId, context }), opts)
      if (!outcome.ok) return
    }
    await sagaRepo.setStepStatus(pool, step.id, 'compensated')
  }
  await sagaRepo.setSagaStatus(pool, sagaId, 'compensated')
}

export async function runSaga(pool, { sagaId, registry, backoff = {}, sleep = defaultSleep }) {
  const saga = await sagaRepo.findSaga(pool, sagaId)
  if (!saga) throw new Error(`saga ${sagaId} not found`)
  if (saga.status === 'completed' || saga.status === 'compensated') return sagaRepo.findSaga(pool, sagaId)
  const context = saga.context
  const steps = await sagaRepo.listSteps(pool, sagaId)
  if (saga.status === 'compensating') {
    const doneCompensatable = steps.filter((step) => step.kind === 'compensatable' && step.status === 'done')
    await compensate(pool, sagaId, doneCompensatable, registry, context, { backoff, sleep })
    return sagaRepo.findSaga(pool, sagaId)
  }
  const compensatableDone = []
  for (const step of steps) {
    if (step.status === 'done') {
      if (step.kind === 'compensatable') compensatableDone.push(step)
      continue
    }
    if (step.status === 'compensated') continue
    const impl = registry.get(step.name)
    if (!impl) throw new Error(`no implementation registered for step "${step.name}"`)
    const outcome = await runStepWithRetry(pool, sagaId, step, impl, context, { backoff, sleep })
    if (outcome.ok) {
      if (step.kind === 'compensatable') compensatableDone.push(step)
      continue
    }
    if (step.kind === 'compensatable') {
      await compensate(pool, sagaId, compensatableDone, registry, context, { backoff, sleep })
      return sagaRepo.findSaga(pool, sagaId)
    }
    await sagaRepo.setSagaStatus(pool, sagaId, 'failed')
    return sagaRepo.findSaga(pool, sagaId)
  }
  await sagaRepo.setSagaStatus(pool, sagaId, 'completed')
  return sagaRepo.findSaga(pool, sagaId)
}

export async function startSaga(client, { type, orderId, context, definition }) {
  const saga = await sagaRepo.createSaga(client, { type, orderId, context })
  for (let i = 0; i < definition.length; i++) {
    const step = definition[i]
    await sagaRepo.addStep(client, {
      sagaId: saga.id,
      position: i,
      name: step.name,
      kind: step.kind,
      maxAttempts: step.maxAttempts
    })
  }
  return saga
}
