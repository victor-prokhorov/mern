import { normalize } from './normalize.js'

export const ALLOWLIST = ['scunthorpe']

export const MIN_SUBSTRING_TERM_LENGTH = 4

function tokenize(text) {
  return text.split(/[^a-z0-9]+/).filter(Boolean)
}

function buildWordIndex(terms) {
  const index = new Map()
  for (const term of terms) {
    index.set(normalize(term.term), term)
  }
  return index
}

function buildSubstringTrie(terms) {
  const root = {}
  for (const term of terms) {
    let node = root
    for (const ch of normalize(term.term)) {
      node = node[ch] || (node[ch] = {})
    }
    node.$ = term
  }
  return root
}

function scanSubstringTrie(word, trie) {
  const found = []
  for (let start = 0; start < word.length; start++) {
    let node = trie
    for (let i = start; i < word.length; i++) {
      node = node[word[i]]
      if (!node) break
      if (node.$) found.push(node.$)
    }
  }
  return found
}

export function scan(text, blockedTerms, allowlist = []) {
  const wordTerms = blockedTerms.filter((term) => term.matchType === 'word')
  const substringTerms = blockedTerms.filter((term) => term.matchType === 'substring')
  const wordIndex = buildWordIndex(wordTerms)
  const substringTrie = buildSubstringTrie(substringTerms)
  const allowSet = new Set(allowlist.map(normalize))
  const words = tokenize(normalize(text))
  const matches = new Map()
  for (const word of words) {
    if (allowSet.has(word)) continue
    if (wordIndex.has(word)) {
      const term = wordIndex.get(word)
      matches.set(term.term, term)
    }
    for (const term of scanSubstringTrie(word, substringTrie)) {
      matches.set(term.term, term)
    }
  }
  return [...matches.values()]
}
