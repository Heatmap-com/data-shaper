import { describe, expect, it } from 'vitest'
import { styleBody } from './html.mjs'
import { reportCss, tokens } from './tokens.mjs'

const logo = 'data:image/svg+xml;base64,AAAA'

describe('styleBody', () => {
  it('replaces the HEATMAP kicker with the logo and styles the site-report masthead', () => {
    const body = [
      '<p><strong>HEATMAP</strong></p>',
      '<p><strong>Tennis Premium</strong></p>',
      '<p><strong>Site Opportunity Report</strong></p>',
      '<p>tennispremium.co | 13 September – 12 October 2026 | Prepared 13 October 2026</p>',
      '<p>This report re-analyses orders.</p>',
    ].join('\n')
    const styled = styleBody(body, { logoDataUri: logo })
    expect(styled).toContain(`src="${logo}"`)
    expect(styled).not.toMatch(/>HEATMAP</)
    expect(styled).toContain('class="brand"')
    expect(styled).toContain('class="doc-title"')
    expect(styled).toContain('class="meta"')
    expect(styled).toContain('This report re-analyses orders.')
  })

  it('keeps one masthead when the banner repeats the title', () => {
    const body = [
      '<p><strong>HEATMAP · Today’s Plan: Move the campaign</strong></p>',
      '<p>Tennis Premium · tennispremium.co Prepared 13 October 2026 | Data through 12 October 2026 A one-hour ad-account intervention</p>',
      '<hr />',
      '<p><strong>Tennis Premium</strong></p>',
      '<p><strong>Today’s Plan: Move the campaign</strong></p>',
      '<p>PREPARED 13 OCTOBER 2026 · DATA THROUGH 12 OCTOBER 2026</p>',
      '<p>The full analysis found the leaks.</p>',
    ].join('\n')
    const styled = styleBody(body, { logoDataUri: logo })
    expect(styled.match(/Today’s Plan/g)).toHaveLength(1)
    expect(styled).toContain('class="prepared"')
    expect(styled).toContain('class="subtitle"')
    expect(styled).toContain('A one-hour ad-account intervention')
    expect(styled).not.toContain('HEATMAP')
  })

  it('marks priorities, contents grids, and captions', () => {
    const body = [
      '<table><tr><td>01 The Situation</td><td>02 Action</td></tr></table>',
      '<table><thead><tr><th>Priority</th></tr></thead><tbody><tr><td>High</td></tr><tr><td>Watch</td></tr></tbody></table>',
      '<p>Table 1 — The three live leaks.</p>',
      '<p><em>Figure 1 — Revenue per visit.</em></p>',
    ].join('\n')
    const styled = styleBody(body, { logoDataUri: logo })
    expect(styled).toContain('class="contents-grid"')
    expect(styled).toContain('class="priority-high"')
    expect(styled).toContain('class="priority-watch"')
    expect(styled).toContain('class="table-caption"')
    expect(styled).toContain('class="figure-caption"')
  })
})

describe('reportCss', () => {
  it('uses the live Heatmap brand, not the older portal green', () => {
    const css = reportCss('', 'Tennis Premium — Site Opportunity Report')
    expect(css).toContain(tokens.brand)
    expect(css).toContain(tokens.forest)
    expect(css).toContain('Poppins')
    expect(css).toContain('Inter')
    expect(css).not.toContain('#079455')
    expect(css).not.toContain('#B88A1A')
  })
})

describe('style-reports arguments', () => {
  it('takes the Chrome binary and the output directory as options', async () => {
    const { parseArgs } = await import('./style-reports.mjs')
    expect(parseArgs(['a.md', '--chrome', '/opt/chromium', '--out', 'pdf', 'b.md'])).toEqual({ files: ['a.md', 'b.md'], out: 'pdf', chrome: '/opt/chromium' })
    expect(() => parseArgs(['a.md', '--chrome'])).toThrow('--chrome needs a value')
    expect(() => parseArgs(['a.md', '--pdf'])).toThrow('unknown argument: --pdf')
  })

  it('reads its page tokens and chart palette from tokens.json', async () => {
    const { readFile } = await import('node:fs/promises')
    const file = JSON.parse(await readFile(new URL('./tokens.json', import.meta.url), 'utf8'))
    expect(tokens).toEqual(file.page)
    expect(Object.keys(file.chart)).toEqual(expect.arrayContaining(['primary', 'highlight', 'context', 'secondary', 'grid', 'font']))
  })
})
