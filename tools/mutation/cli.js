import path from 'node:path'
import { APPS } from './apps.js'
import { discoverSourceFiles } from './discover.js'
import { runMutationTesting } from './run.js'
import { summarize, formatReport } from './report.js'

function parseArgs(argv) {
  const args = { max: null, seed: '1', timeout: 20000, files: null, out: null, src: 'src' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--app') args.app = argv[++i]
    else if (arg === '--files') args.files = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--max') args.max = Number(argv[++i])
    else if (arg === '--seed') args.seed = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--timeout') args.timeout = Number(argv[++i])
    else if (arg === '--src') args.src = argv[++i]
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.app || !APPS[args.app]) {
    console.error(`usage: node cli.js --app <${Object.keys(APPS).join('|')}> [--files a.js,b.js] [--max N] [--seed S] [--out results.json]`)
    process.exit(1)
  }
  const { appRoot, testCommand } = APPS[args.app]
  const files = args.files ?? discoverSourceFiles(appRoot, args.src)
  const outFile = args.out ?? path.join(appRoot, `.mutation-results.${args.app}.json`)
  console.log(`mutation testing: app=${args.app} files=${files.length} seed=${args.seed} max=${args.max ?? 'unbounded'}`)
  const { results } = await runMutationTesting({
    appRoot,
    testCwd: appRoot,
    testCommand,
    files,
    seed: args.seed,
    max: args.max,
    outFile,
    timeoutMs: args.timeout,
    onProgress: ({ mutant, status, skipped }) => {
      const tag = skipped ? 'skip' : 'run '
      console.log(`  [${tag}] ${mutant.file}:${mutant.line} ${mutant.operator} -> ${status}`)
    }
  })
  const summary = summarize(results)
  console.log('')
  console.log(formatReport(summary))
  console.log('')
  console.log(`results written to ${outFile}`)
}

main()
