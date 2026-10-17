import { readFileSync } from 'node:fs'

/**
 * Heatmap page tokens.
 *
 * heatmap.com `.hm-web` (release 2026-10-06) wins where it disagrees with
 * `/Users/kennpalm/Documents/heatmap-style-guide/style-guide.md`:
 * brand green is #10b068, not the portal's #079455; display type is Poppins,
 * not Montserrat. The logo file is forest #004225 and is not recolored.
 * Table header, body, and muted text follow the portal guide's concrete hexes.
 * The values live in tokens.json, which py/chart-render.py also reads for the
 * chart palette.
 */
export const tokens = JSON.parse(readFileSync(new URL('./tokens.json', import.meta.url), 'utf8')).page

const FONT_DIR = new URL('./fonts/', import.meta.url)

export async function fontFaces() {
  const faces = [
    ['Inter', 400, 'normal', 'Inter-normal-400.woff2'],
    ['Inter', 500, 'normal', 'Inter-normal-500.woff2'],
    ['Inter', 600, 'normal', 'Inter-normal-600.woff2'],
    ['Inter', 400, 'italic', 'Inter-italic-400.woff2'],
    ['Poppins', 500, 'normal', 'Poppins-normal-500.woff2'],
    ['Poppins', 600, 'normal', 'Poppins-normal-600.woff2'],
    ['Poppins', 700, 'normal', 'Poppins-normal-700.woff2'],
  ]
  const css = []
  for (const [family, weight, style, file] of faces) {
    const bytes = await readFont(file)
    css.push(
      `@font-face{font-family:${family};font-style:${style};font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${bytes}) format('woff2');}`,
    )
  }
  return css.join('\n')
}

async function readFont(file) {
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(new URL(file, FONT_DIR))
  return bytes.toString('base64')
}

export function reportCss(faces, footer) {
  const safeFooter = footer.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `
${faces}
:root {
  --forest: ${tokens.forest};
  --brand: ${tokens.brand};
  --brand-strong: ${tokens.brandStrong};
  --brand-tint: ${tokens.brandTint};
  --warning: ${tokens.warning};
  --ink: ${tokens.ink};
  --body: ${tokens.body};
  --muted: ${tokens.muted};
}
@page {
  size: letter;
  margin: 0.7in 0.72in 0.65in;
  @bottom-left {
    content: "${safeFooter}";
    font-family: Inter, sans-serif;
    font-size: 11px;
    color: ${tokens.muted};
  }
  @bottom-right {
    content: counter(page);
    font-family: Inter, sans-serif;
    font-size: 11px;
    color: ${tokens.muted};
  }
}
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html { font-size: 14px; }
body {
  font-family: Inter, system-ui, sans-serif;
  font-weight: 400;
  line-height: 1.5;
  color: ${tokens.body};
  background: ${tokens.white};
  margin: 0 auto;
  max-width: 7.1in;
}
h1, h2, h3, .brand, .doc-title {
  font-family: Poppins, Inter, sans-serif;
  color: ${tokens.ink};
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.25;
  page-break-after: avoid;
}
h1 { font-size: 18px; margin: 28px 0 8px; }
h2 { font-size: 15px; margin: 20px 0 6px; }
h3 { font-size: 14px; margin: 16px 0 4px; }
p { margin: 8px 0; orphans: 3; widows: 3; }
.masthead { margin: 0 0 18px; }
.logo { width: 128px; height: auto; display: block; }
.brand, .brand strong {
  font-size: 28px; font-weight: 600; color: ${tokens.ink};
  letter-spacing: -0.03em; line-height: 1.15; margin: 0;
}
.doc-title, .doc-title strong {
  font-size: 20px; font-weight: 600; color: ${tokens.ink};
  letter-spacing: -0.03em; line-height: 1.25; margin: 2px 0 6px;
}
.meta, .prepared, .subtitle { color: ${tokens.muted}; font-size: 12px; line-height: 1.4; margin: 0 0 12px; }
.prepared { letter-spacing: 0.04em; }
.contents-line { font-size: 13px; line-height: 1.45; color: ${tokens.body}; }
hr, hr.banner-rule { display: none; }
blockquote {
  margin: 12px 0 16px; padding: 12px 16px;
  border-left: 3px solid ${tokens.brand};
  background: ${tokens.brandTint};
  border-radius: 0 8px 8px 0;
  color: ${tokens.ink};
}
blockquote p { margin: 4px 0; }
table {
  width: 100%; border-collapse: collapse; margin: 12px 0 4px;
  font-size: 13px; line-height: 1.4;
}
thead { display: table-header-group; }
th {
  background: ${tokens.headerBg}; color: ${tokens.muted};
  font-family: Inter, sans-serif; font-weight: 600; font-size: 12px;
  letter-spacing: 0; text-align: left; vertical-align: bottom;
  padding: 8px 10px; border-bottom: 1px solid ${tokens.line};
}
th strong { font-weight: 600; color: inherit; background: transparent; border: 0; }
td {
  color: ${tokens.ink}; font-size: 13px; padding: 8px 10px;
  border-bottom: 1px solid ${tokens.line}; vertical-align: top;
  overflow-wrap: anywhere;
}
td[style*="text-align: right"], th[style*="text-align: right"] { text-align: right; }
tbody tr:nth-child(even) td { background: ${tokens.surface}; }
table.contents-grid th, table.contents-grid th strong {
  background: transparent; color: ${tokens.ink}; font-weight: 600;
}
table.contents-grid td, table.contents-grid th { width: 50%; }
td.priority-high, td.priority-high strong { color: ${tokens.brand}; font-weight: 600; }
td.priority-watch, td.priority-watch strong { color: ${tokens.warning}; font-weight: 600; }
.table-caption, .figure-caption, .figure-caption em, figcaption {
  font-size: 12px; color: ${tokens.muted}; font-style: italic; margin: 2px 0 14px;
}
figure:has(+ p.figure-caption) figcaption { display: none; }
figure { margin: 16px 0 4px; page-break-inside: avoid; }
img { display: block; max-width: 100%; height: auto; }
ul, ol { margin: 6px 0 12px; padding-left: 1.2em; }
li { margin: 3px 0; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em; color: ${tokens.ink};
}
`
}
