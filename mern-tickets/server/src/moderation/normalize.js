export function toNFKC(text) {
  return text.normalize('NFKC')
}

const ZERO_WIDTH_PATTERN = /[​‌‍⁠﻿]/g

export function stripZeroWidth(text) {
  return text.replace(ZERO_WIDTH_PATTERN, '')
}

export function toLowerCase(text) {
  return text.toLowerCase()
}

const HOMOGLYPHS = {
  '0': 'o',
  '1': 'i',
  '@': 'a',
  $: 's',
  'а': 'a',
  'е': 'e',
  'о': 'o',
  'р': 'p',
  'с': 'c',
  'х': 'x',
  'у': 'y'
}

export function mapHomoglyphs(text) {
  let mapped = ''
  for (const ch of text) {
    mapped += HOMOGLYPHS[ch] || ch
  }
  return mapped
}

export function collapseRepeats(text) {
  return text.replace(/(.)\1+/g, '$1')
}

export function normalize(text) {
  return collapseRepeats(mapHomoglyphs(toLowerCase(stripZeroWidth(toNFKC(text)))))
}
