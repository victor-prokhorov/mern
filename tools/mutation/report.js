export function summarize(results) {
  const perFile = new Map()
  for (const entry of results) {
    if (!perFile.has(entry.file)) {
      perFile.set(entry.file, { killed: 0, survived: 0, error: 0, total: 0 })
    }
    const stats = perFile.get(entry.file)
    stats.total += 1
    if (entry.status === 'killed') stats.killed += 1
    else if (entry.status === 'survived') stats.survived += 1
    else stats.error += 1
  }
  let totalKilled = 0
  let totalSurvived = 0
  let totalError = 0
  for (const stats of perFile.values()) {
    totalKilled += stats.killed
    totalSurvived += stats.survived
    totalError += stats.error
  }
  const total = totalKilled + totalSurvived + totalError
  const survivors = results.filter((entry) => entry.status === 'survived')
  return {
    perFile,
    total,
    totalKilled,
    totalSurvived,
    totalError,
    score: total > 0 ? totalKilled / total : null,
    survivors
  }
}

export function formatReport(summary) {
  const lines = []
  lines.push('Mutation score per file:')
  for (const [file, stats] of summary.perFile.entries()) {
    const score = stats.total > 0 ? ((stats.killed / stats.total) * 100).toFixed(1) : 'n/a'
    lines.push(`  ${file}: ${score}% (${stats.killed}/${stats.total} killed, ${stats.survived} survived, ${stats.error} error)`)
  }
  const overall = summary.score !== null ? (summary.score * 100).toFixed(1) : 'n/a'
  lines.push(`Overall: ${overall}% (${summary.totalKilled}/${summary.total} killed)`)
  if (summary.survivors.length > 0) {
    lines.push('')
    lines.push('Survivors:')
    for (const s of summary.survivors) {
      lines.push(`  ${s.file}:${s.line} [${s.operator}] "${s.original}" -> "${s.mutated}"`)
    }
  }
  return lines.join('\n')
}
