import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScreen } from '../domain/quality/screens.js';

const shipped = path.join(path.dirname(fileURLToPath(import.meta.url)), 'quality');

/**
 * The shipped data-quality screens, one JSON file each in
 * src/catalog/quality/, named by the screen id.
 * @param {string} [dir]
 * @returns {import('../domain/quality/screens.js').Screen[]}
 */
export function loadQualityScreens(dir = shipped) {
  const screens = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const where = `catalog quality/${file}`;
    const screen = checkScreen(JSON.parse(readFileSync(path.join(dir, file), 'utf8')), where);
    if (`${screen.id}.json` !== file) throw new Error(`${where}: the file is named for screen ${screen.id}`);
    screens.push(screen);
  }
  return screens;
}
