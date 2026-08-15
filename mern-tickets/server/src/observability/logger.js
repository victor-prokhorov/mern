import { getContext } from './context.js'

function defaultWriter(line) {
  process.stdout.write(line + '\n')
}

let currentWriter = defaultWriter

export function setWriter(write) {
  currentWriter = write
}

export function resetWriter() {
  currentWriter = defaultWriter
}

function emit(level, msg, fields) {
  const context = getContext()
  const entry = {
    level,
    msg,
    time: new Date().toISOString(),
    requestId: context ? context.requestId : undefined,
    userId: context ? context.userId : undefined,
    route: context ? context.route : undefined,
    ...fields
  }
  currentWriter(JSON.stringify(entry))
}

export const logger = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields)
}
