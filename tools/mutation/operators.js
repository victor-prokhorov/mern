import { isMutableSpan } from './lexer.js'

const COMPARISON_RE = /<=|>=|===|!==|=>|<|>/g
const LOGICAL_RE = /&&|\|\|/g
const IF_RE = /\bif\s*\(/g
const AWAIT_RE = /\bawait\s+/g
const NUMBER_RE = /(?<![\w.])\d+(?!\.\d)(?!\w)/g
const RETURN_RE = /\breturn[ \t]+([^\n;]+?)[ \t]*(;?)(?=\n|$)/g
const FUNC_HEAD_RE = /(?:\basync\s+)?\bfunction\b\s*[$A-Za-z_][\w$]*\s*\([^()]*\)\s*\{|(?:\basync\s+)?\bfunction\b\s*\([^()]*\)\s*\{|\([^()]*\)\s*=>\s*\{|\b[$A-Za-z_][\w$]*\s*=>\s*\{|\b(?:get|set)\s+[$A-Za-z_][\w$]*\s*\([^()]*\)\s*\{|\bconstructor\s*\([^()]*\)\s*\{/g

const TRIVIAL_RETURNS = new Set(['null', 'undefined', 'true', 'false'])

function findMatchingBrace(source, mask, openIndex) {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    if (mask[i] !== 1) continue
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function comparisonFlip(source, mask) {
  const candidates = []
  for (const match of source.matchAll(COMPARISON_RE)) {
    const op = match[0]
    const start = match.index
    const end = start + op.length
    if (!isMutableSpan(mask, start, end)) continue
    if (op === '=>') continue
    let mutated = null
    if (op === '<=') mutated = '<'
    else if (op === '<') mutated = '<='
    else if (op === '>=') mutated = '>'
    else if (op === '>') mutated = '>='
    else if (op === '===') mutated = '!=='
    else if (op === '!==') mutated = '==='
    if (mutated === null) continue
    candidates.push({
      operator: 'comparison-flip',
      start,
      end,
      original: op,
      mutated
    })
  }
  return candidates
}

function logicalSwap(source, mask) {
  const candidates = []
  for (const match of source.matchAll(LOGICAL_RE)) {
    const op = match[0]
    const start = match.index
    const end = start + op.length
    if (!isMutableSpan(mask, start, end)) continue
    const mutated = op === '&&' ? '||' : '&&'
    candidates.push({
      operator: 'logical-swap',
      start,
      end,
      original: op,
      mutated
    })
  }
  return candidates
}

function negateCondition(source, mask) {
  const candidates = []
  for (const match of source.matchAll(IF_RE)) {
    const openParenIndex = match.index + match[0].length - 1
    if (mask[openParenIndex] !== 1) continue
    let depth = 0
    let closeParenIndex = -1
    for (let i = openParenIndex; i < source.length; i += 1) {
      if (mask[i] !== 1) continue
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') {
        depth -= 1
        if (depth === 0) {
          closeParenIndex = i
          break
        }
      }
    }
    if (closeParenIndex === -1) continue
    const condStart = openParenIndex + 1
    const condEnd = closeParenIndex
    const cond = source.slice(condStart, condEnd)
    if (cond.trim().length === 0) continue
    candidates.push({
      operator: 'negate-condition',
      start: condStart,
      end: condEnd,
      original: cond,
      mutated: `!(${cond})`
    })
  }
  return candidates
}

function removeAwait(source, mask) {
  const candidates = []
  for (const match of source.matchAll(AWAIT_RE)) {
    const start = match.index
    const end = start + match[0].length
    if (!isMutableSpan(mask, start, end)) continue
    candidates.push({
      operator: 'remove-await',
      start,
      end,
      original: match[0],
      mutated: ''
    })
  }
  return candidates
}

function numericLiteralShift(source, mask) {
  const candidates = []
  for (const match of source.matchAll(NUMBER_RE)) {
    const start = match.index
    const end = start + match[0].length
    if (!isMutableSpan(mask, start, end)) continue
    const value = Number(match[0])
    candidates.push({
      operator: 'numeric-literal-shift',
      start,
      end,
      original: match[0],
      mutated: String(value + 1)
    })
  }
  return candidates
}

function returnValueReplace(source, mask, rng) {
  const candidates = []
  for (const match of source.matchAll(RETURN_RE)) {
    const exprStart = match.index + match[0].indexOf(match[1])
    const exprEnd = exprStart + match[1].length
    if (!isMutableSpan(mask, exprStart, exprEnd)) continue
    const trimmed = match[1].trim()
    if (TRIVIAL_RETURNS.has(trimmed)) continue
    const options = ['null', 'undefined', 'true', 'false']
    const replacement = options[Math.floor(rng() * options.length)]
    candidates.push({
      operator: 'return-value-replace',
      start: exprStart,
      end: exprEnd,
      original: match[1],
      mutated: replacement
    })
  }
  return candidates
}

function emptyFunctionBody(source, mask) {
  const candidates = []
  for (const match of source.matchAll(FUNC_HEAD_RE)) {
    const openBraceIndex = match.index + match[0].length - 1
    if (mask[openBraceIndex] !== 1) continue
    const closeBraceIndex = findMatchingBrace(source, mask, openBraceIndex)
    if (closeBraceIndex === -1) continue
    const bodyStart = openBraceIndex + 1
    const bodyEnd = closeBraceIndex
    const body = source.slice(bodyStart, bodyEnd)
    if (body.trim().length === 0) continue
    candidates.push({
      operator: 'empty-function-body',
      start: bodyStart,
      end: bodyEnd,
      original: body,
      mutated: ''
    })
  }
  return candidates
}

export const operators = [
  { id: 'comparison-flip', find: comparisonFlip },
  { id: 'logical-swap', find: logicalSwap },
  { id: 'negate-condition', find: negateCondition },
  { id: 'remove-await', find: removeAwait },
  { id: 'numeric-literal-shift', find: numericLiteralShift },
  { id: 'return-value-replace', find: returnValueReplace },
  { id: 'empty-function-body', find: emptyFunctionBody }
]

export function findAllMutants(source, mask, rng) {
  const all = []
  for (const op of operators) {
    const found = op.find(source, mask, rng)
    for (const candidate of found) all.push(candidate)
  }
  all.sort((a, b) => a.start - b.start)
  return all
}
