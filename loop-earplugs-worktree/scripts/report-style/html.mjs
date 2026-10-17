const BLOCK = /(<p\b[^>]*>[\s\S]*?<\/p>|<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>|<blockquote\b[^>]*>[\s\S]*?<\/blockquote>|<table\b[^>]*>[\s\S]*?<\/table>|<hr\s*\/?>|<figure\b[^>]*>[\s\S]*?<\/figure>)/g

export function plain(fragment) {
  return fragment
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function addClass(block, className) {
  return block.replace(/^<(\w+)/, `<$1 class="${className}"`)
}

function heatmapRemainder(text) {
  const match = text.match(/^HEATMAP(?:\s*[·•]\s*)?(.*)$/i)
  return match ? match[1].trim() : null
}

function isStrongLine(block) {
  const text = plain(block)
  if (text.length < 2 || text.length > 140) return false
  const inner = block.replace(/^<p[^>]*>/, '').replace(/<\/p>$/, '').trim()
  return /^<strong>[\s\S]*<\/strong>$/.test(inner)
}

function bannerSubtitle(text) {
  const match = text.match(/^(.+ · \S+)\s+(Prepared .+)$/)
  if (!match) return null
  const years = [...match[2].matchAll(/\d{4}/g)]
  if (years.length < 2) return ''
  const cut = years[1].index + years[1][0].length
  return match[2].slice(cut).trim()
}

function markTable(block) {
  const cells = [...block.matchAll(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/g)].map((match) => plain(match[0]))
  const filled = cells.filter(Boolean)
  let next = filled.length && filled.every((cell) => /^(?:\d{2}|A)\s+\S/.test(cell))
    ? addClass(block, 'contents-grid')
    : addClass(block, 'data')
  next = next.replace(/<td\b[^>]*>[\s\S]*?<\/td>/g, (cell) => {
    const label = plain(cell)
    const kind = { High: 'priority-high', Medium: 'priority-medium', Watch: 'priority-watch' }[label]
    return kind ? addClass(cell, kind) : cell
  })
  return next
}

/**
 * Apply the Heatmap page to a pandoc HTML body.
 * The HEATMAP kicker becomes the logo. A repeated banner in front of the
 * real masthead is dropped.
 *
 * @param {string} body
 * @param {{ logoDataUri: string }} options
 */
export function styleBody(body, { logoDataUri }) {
  const parts = []
  let last = 0
  for (const match of body.matchAll(BLOCK)) {
    if (match.index > last) parts.push(body.slice(last, match.index))
    parts.push({ html: match[0] })
    last = match.index + match[0].length
  }
  if (last < body.length) parts.push(body.slice(last))

  const blocks = parts.filter((part) => typeof part === 'object')
  const hr = blocks.findIndex((block) => block.html.startsWith('<hr'))
  const after = hr >= 0 ? blocks.slice(hr + 1) : []
  const hasBodyMasthead = after.some((block) => plain(block.html).startsWith('PREPARED'))
  let subtitle = ''

  for (const block of blocks) {
    if (!block.html.startsWith('<p')) continue
    const text = plain(block.html)
    const remainder = heatmapRemainder(text)
    if (remainder !== null) {
      if (hasBodyMasthead || !remainder) block.html = ''
      else block.html = `<p class="doc-title"><strong>${escapeHtml(remainder)}</strong></p>`
      continue
    }
    const extra = bannerSubtitle(text)
    if (extra !== null) {
      subtitle = extra
      block.html = ''
    }
  }

  let strongCount = 0
  let placedSubtitle = false
  for (const block of blocks) {
    if (block.html.startsWith('<hr')) {
      block.html = '<hr class="banner-rule" />'
      continue
    }
    if (block.html.startsWith('<table')) {
      block.html = markTable(block.html)
      continue
    }
    if (!block.html.startsWith('<p') || block.html.includes('class="doc-title"')) continue
    const text = plain(block.html)
    if (!text) continue
    if (isStrongLine(block.html) && strongCount < 2 && !text.startsWith('PREPARED')) {
      block.html = addClass(block.html, strongCount === 0 ? 'brand' : 'doc-title')
      strongCount += 1
      continue
    }
    if (text.startsWith('PREPARED')) {
      block.html = addClass(block.html, 'prepared')
      if (subtitle && !placedSubtitle) {
        block.html += `<p class="subtitle">${escapeHtml(subtitle)}</p>`
        placedSubtitle = true
      }
      continue
    }
    if (/\|/.test(text) && /\d{4}/.test(text) && text.length < 180) {
      block.html = addClass(block.html, 'meta')
      continue
    }
    if (text.startsWith('Table ')) {
      block.html = addClass(block.html, 'table-caption')
      continue
    }
    if (text.startsWith('Figure ')) {
      block.html = addClass(block.html, 'figure-caption')
      continue
    }
    if ((text.match(/ · /g) || []).length >= 6) block.html = addClass(block.html, 'contents-line')
  }

  if (subtitle && !placedSubtitle) {
    const mast = `<p class="subtitle">${escapeHtml(subtitle)}</p>`
    const brand = blocks.find((block) => block.html.includes('class="brand"'))
    if (brand) brand.html += mast
  }

  const logo = `<div class="masthead"><img class="logo" alt="heatmap" src="${logoDataUri}"></div>`
  return logo + parts.map((part) => (typeof part === 'string' ? part : part.html)).join('')
}

export function styleDocument(html, options) {
  return html.replace(/<body>([\s\S]*)<\/body>/, (_, body) => `<body>${styleBody(body, options)}</body>`)
}
