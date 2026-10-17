import { writeFile } from 'node:fs/promises';
import { createStore } from '../../../src/orchestrator/adapters/queue/sqlite.js';

const [dbFile, owner, outFile] = process.argv.slice(2);
const store = createStore({ path: dbFile });
const claimed = [];
const deadline = Date.now() + 15_000;
let misses = 0;
while (Date.now() < deadline && misses < 10) {
  const lease = await store.queue.reserve('stage:two-process', { leaseMs: 10000, owner });
  if (!lease) {
    misses += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    continue;
  }
  misses = 0;
  claimed.push(lease.message.id);
  await store.queue.ack(lease);
  await new Promise((resolve) => setTimeout(resolve, 10));
}
store.close();
await writeFile(outFile, JSON.stringify({ owner, claimed }));
