const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const grouped = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * The ways a report may write a bundle number: exact with or without
 * thousands separators, and rounded to a whole number when the anchor's
 * tolerance allows it. `6404.73` gives `6,404.73`, `6404.73`, `6,405`, `6405`.
 *
 * @param {number} value
 * @param {number} [tolerance]
 * @returns {string[]}
 */
export function numberForms(value, tolerance = 0) {
  const forms = new Set();
  const add = (text) => { forms.add(text); forms.add(grouped(text.split('.')[0]) + (text.includes('.') ? `.${text.split('.')[1]}` : '')); };
  if (Number.isInteger(value)) add(String(value));
  else {
    add(value.toFixed(2));
    if (Number(value.toFixed(1)) === value) add(value.toFixed(1));
  }
  if (Math.abs(Math.round(value) - value) <= tolerance) add(String(Math.round(value)));
  return [...forms];
}

/** A number form as a standalone token: not part of a longer number. */
export function numberPattern(form) {
  return new RegExp(`(?<![\\d.,])${form.replace(/[.,]/g, '\\$&')}(?!\\d|[.,]\\d)`);
}

/** `2026-10-12` as the documents write it: ISO, `12 October 2026`, `October 12, 2026`. */
export function dateForms(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  const name = MONTHS[month - 1];
  if (!name) return [String(iso)];
  return [String(iso), `${day} ${name} ${year}`, `${name} ${day}, ${year}`];
}
