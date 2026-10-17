import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { checkKey, toEntry } from './_entry.js';

const zip = promisify(gzip);
const unzip = promisify(gunzip);

/**
 * The day store as files on this machine: one gzip JSON file per entry,
 * at `<dir>/<idsite>/<kind>/<key or _>/<day>.json.gz`. A write goes to a
 * temporary file and is renamed into place, so a reader sees the old entry
 * or the new one whole. `prune` removes a site's files of earlier days.
 * @param {{dir: string}} opts
 * @returns {import('../../ports/day-store.js').DayStore}
 */
export function createLocalDayStore({ dir }) {
  if (!dir) throw new Error('local day store: dir is required');
  const fileOf = (key) => {
    checkKey(key);
    return path.join(dir, String(key.idsite), key.kind, key.key || '_', `${key.day}.json.gz`);
  };
  return {
    id: 'local',
    async read(key) {
      let bytes;
      try {
        bytes = await readFile(fileOf(key));
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      return JSON.parse((await unzip(bytes)).toString('utf8'));
    },
    async write(entry) {
      const file = fileOf(entry);
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, await zip(JSON.stringify(toEntry(entry))));
      await rename(temp, file);
    },
    async prune({ idsite, before }) {
      checkKey({ idsite, kind: 'day', key: '', day: before });
      let dropped = 0;
      for (const leaf of await leaves(path.join(dir, String(idsite)))) {
        for (const name of await listed(leaf)) {
          const day = DAY_FILE.exec(name)?.[1];
          if (!day || day >= before) continue;
          await rm(path.join(leaf, name), { force: true });
          dropped += 1;
        }
      }
      return dropped;
    },
  };
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json\.gz$/;

/** A directory's entries, or none when it is missing. */
async function listed(dir) {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

/** A site's `<kind>/<key>` directories. */
async function leaves(siteDir) {
  const out = [];
  for (const kind of await listed(siteDir)) {
    for (const key of await listed(path.join(siteDir, kind))) out.push(path.join(siteDir, kind, key));
  }
  return out;
}

export const adapter = {
  id: 'local',
  create: createLocalDayStore,
};
