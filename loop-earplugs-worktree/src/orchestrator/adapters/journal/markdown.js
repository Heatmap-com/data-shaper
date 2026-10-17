import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Appends `- <iso> — <message>` to process/journal/<jobId>.md. A new file
 * starts with the header table the legacy queue wrote, so old and new
 * journals read the same, and an imported job keeps its legacy journal.
 *
 * @param {{dir: string, clock: {now: () => Date}}} deps
 * @returns {import('../../ports/journal.js').JournalPort}
 */
export function createMarkdownJournal({ dir, clock }) {
  return { record };

  async function record(job, event) {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${job.id}.md`);
    const line = `- ${clock.now().toISOString()} — ${event.message ?? event.type}\n`;
    try {
      await writeFile(file, `${header(job)}${line}`, { flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await appendFile(file, line);
    }
  }
}

function header(job) {
  return [
    `# ${job.site.domain}`,
    '',
    '| | |',
    '| --- | --- |',
    `| id | ${job.id} |`,
    `| run | ${job.run?.id ?? ''} |`,
    `| priority | ${job.priority} |`,
    `| resilience | ${job.resilience} |`,
    `| domain | ${job.site.domain} |`,
    '',
    '## Log',
    '',
  ].join('\n');
}
