import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { styleDocument } from './html.mjs'
import { fontFaces, reportCss } from './tokens.mjs'

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ROOT = new URL('./', import.meta.url)

export function parseArgs(argv) {
  const files = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true, files }
    if (arg === '--out' || arg === '--chrome') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      options[arg.slice(2)] = value
      i += 1
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    files.push(arg)
  }
  if (!files.length) throw new Error('at least one markdown file is required')
  return { files, out: options.out, chrome: options.chrome }
}

export const USAGE = `usage: node scripts/report-style/style-reports.mjs <report.md> ... [--out <dir>] [--chrome <path>]

Writes a Heatmap-styled PDF next to each markdown file. --out writes them into that directory instead.
--chrome is the Chrome or Chromium binary; the orchestrator passes config.report.chromePath. Without it, the macOS default is used.
`

/**
 * @param {string[]} argv
 * @param {{ chrome?: string }} [deps]
 */
export async function main(argv, deps = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(err.message)
    console.error(USAGE)
    return 2
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  const chrome = args.chrome ?? deps.chrome ?? DEFAULT_CHROME
  const logo = await readFile(new URL('./logo.svg', ROOT))
  const logoDataUri = `data:image/svg+xml;base64,${logo.toString('base64')}`
  const faces = await fontFaces()
  if (args.out) await mkdir(args.out, { recursive: true })

  for (const file of args.files) {
    const source = path.resolve(file)
    const stem = path.basename(source, path.extname(source))
    const pdf = args.out ? path.join(args.out, `${stem}.pdf`) : path.join(path.dirname(source), `${stem}.pdf`)
    await renderPdf({ source, pdf, stem, chrome, logoDataUri, faces })
    console.error(`${pdf}`)
  }
  return 0
}

async function renderPdf({ source, pdf, stem, chrome, logoDataUri, faces }) {
  const work = path.join(tmpdir(), 'heatmap-report-style')
  await mkdir(work, { recursive: true })
  const htmlPath = path.join(work, `${stem}.html`)
  const cssPath = path.join(work, `${stem}.css`)
  await writeFile(cssPath, reportCss(faces, stem))
  const pandoc = spawnSync(
    'pandoc',
    [
      source,
      '--from',
      'markdown',
      '--to',
      'html5',
      '--standalone',
      '--embed-resources',
      `--resource-path=${path.dirname(source)}`,
      '--metadata',
      `pagetitle=${stem}`,
      '--css',
      cssPath,
      '-o',
      htmlPath,
    ],
    { encoding: 'utf8' },
  )
  if (pandoc.status !== 0) {
    throw new Error(pandoc.stderr || `pandoc failed on ${source}`)
  }
  const styled = styleDocument(await readFile(htmlPath, 'utf8'), { logoDataUri })
  await writeFile(htmlPath, styled)
  const printed = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--user-data-dir=${path.join(work, 'chrome')}`,
      `--print-to-pdf=${pdf}`,
      pathToFileURL(htmlPath).href,
    ],
    { encoding: 'utf8' },
  )
  if (printed.status !== 0) {
    throw new Error(printed.stderr || `Chrome failed to write ${pdf}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)))
}
