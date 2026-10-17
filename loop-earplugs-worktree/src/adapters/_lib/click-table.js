/**
 * A page's clicks held by column: each text field as an index into its own
 * dictionary, each number in a plain array. A click costs a few numbers in
 * place of one object with its own strings, so a page with millions of
 * clicks fits beside the session rows. Iterating yields one click object
 * at a time, in the order the clicks were added, with the fields
 * getClickRows has always returned.
 */

const TEXT = ['idvisit', 'idloghsr', 'selector', 'week', 'date', 'serverTime', 'meta1'];

/**
 * @typedef {{idvisit: string, idloghsr: string, selector: string, week: string, date: string,
 *   serverTime: string, meta1: string, x: number | null, y: number | null, timeSinceLoad: number}} Click
 */

export function createClickTable() {
  /** @type {Record<string, {values: string[], index: Map<string, number>, column: number[]}>} */
  const text = Object.fromEntries(TEXT.map((field) => [field, { values: [], index: new Map(), column: [] }]));
  const xs = [];
  const ys = [];
  const tsls = [];

  /** @param {string} field @param {string} value */
  const intern = (field, value) => {
    const dict = text[field];
    let i = dict.index.get(value);
    if (i === undefined) {
      i = dict.values.length;
      dict.values.push(value);
      dict.index.set(value, i);
    }
    dict.column.push(i);
  };

  return {
    get length() {
      return tsls.length;
    },

    /** @param {Click} click */
    push(click) {
      for (const field of TEXT) intern(field, click[field]);
      xs.push(click.x ?? NaN);
      ys.push(click.y ?? NaN);
      tsls.push(click.timeSinceLoad);
    },

    /** @returns {Generator<Click>} */
    *[Symbol.iterator]() {
      for (let i = 0; i < tsls.length; i += 1) {
        yield {
          idvisit: text.idvisit.values[text.idvisit.column[i]],
          idloghsr: text.idloghsr.values[text.idloghsr.column[i]],
          selector: text.selector.values[text.selector.column[i]],
          week: text.week.values[text.week.column[i]],
          date: text.date.values[text.date.column[i]],
          serverTime: text.serverTime.values[text.serverTime.column[i]],
          meta1: text.meta1.values[text.meta1.column[i]],
          x: Number.isNaN(xs[i]) ? null : xs[i],
          y: Number.isNaN(ys[i]) ? null : ys[i],
          timeSinceLoad: tsls[i],
        };
      }
    },
  };
}
