import { computeMutableMask } from './lexer.js'
import { findAllMutants } from './operators.js'
import { seededRng } from './random.js'

export function lineOf(source, offset) {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1
  }
  return line
}

export function buildMutantList(files, sources, seed) {
  const rng = seededRng(seed)
  const mutants = []
  for (const file of files) {
    const source = sources.get(file)
    const mask = computeMutableMask(source)
    const found = findAllMutants(source, mask, rng)
    found.forEach((candidate, index) => {
      const line = lineOf(source, candidate.start)
      const id = `${file}::${candidate.operator}::${line}::${index}`
      mutants.push({
        id,
        file,
        line,
        operator: candidate.operator,
        start: candidate.start,
        end: candidate.end,
        original: candidate.original,
        mutated: candidate.mutated
      })
    })
  }
  return mutants
}

export function applyMutation(source, mutant) {
  return source.slice(0, mutant.start) + mutant.mutated + source.slice(mutant.end)
}
