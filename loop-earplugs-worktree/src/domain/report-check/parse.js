/**
 * The parts of a markdown report the checks read: headings, image links, and
 * the word count. Fenced code is ignored.
 *
 * @param {string} text
 * @returns {{text: string, headings: Array<{level: number, text: string}>, images: string[], words: number}}
 */
export function parseMarkdown(text) {
  const prose = String(text).replace(/^```[\s\S]*?^```/gm, '');
  const headings = [...prose.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((m) => ({ level: m[1].length, text: m[2] }));
  const images = [...prose.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => decodeURI(m[1]));
  const words = (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,%$-]*/gu) ?? []).length;
  return { text: prose, headings, images, words };
}

const fold = (value) => String(value).normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const NUMBERING = /^(?:\d{1,2}|[a-z])[.)]?\s+(?=\S)/;

/**
 * Whether a heading is the named section. A name matches the heading's start,
 * with or without the heading's own number: "The biggest wins" matches
 * "The biggest wins, first", "04" matches "04 How the Sales Reshaped the
 * Funnel", and "Action 1" matches "02 Action 1 — Move budget off ad 1202…".
 */
export function headingMatches(heading, name) {
  const want = fold(name);
  return [fold(heading), fold(heading).replace(NUMBERING, '')].some((text) => text.startsWith(want) && !/[\p{L}\p{N}]/u.test(text.charAt(want.length)));
}
