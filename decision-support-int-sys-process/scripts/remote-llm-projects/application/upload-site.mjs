import { readFile } from 'node:fs/promises';

const STANDING = `This project is the working set for one site. data/ is the full analyst bundle. reports/ holds the three source reports. style-guide.md is how those reports must read. enhanced/ is where the enhanced reports are written. Numbers come from data/. The style guide governs the prose.`;

/**
 * Create the project if needed, then store the bundle, the three reports,
 * and the style guide. A file already at that path is replaced.
 *
 * @param {import('../ports/remote-project.mjs').RemoteProjectPort} port
 * @param {{ name: string, files: { path: string, absolutePath?: string, body?: Buffer | string }[] }} request
 * @param {(line: string) => void} [log]
 */
export async function uploadSite(port, request, log = () => {}) {
  if (typeof port?.ensureProject !== 'function' || typeof port?.putFile !== 'function') {
    throw new Error('project port is missing ensureProject or putFile');
  }
  const name = request?.name?.trim() ?? '';
  if (!name) throw new Error('name is required');
  const incoming = request.files ?? [];
  if (!incoming.length) throw new Error('no files to upload');

  log(`creating project ${name}`);
  const project = await port.ensureProject({ name, instructions: STANDING });
  log(`project ${project.id} (${project.name})`);

  const uploaded = [];
  for (const file of incoming) {
    const body = file.body ?? (await readFile(file.absolutePath));
    const label = file.path === 'style-guide.md' ? 'updating style-guide.md' : `upload ${file.path}`;
    log(`${label} (${body.length} bytes)`);
    await port.putFile(project.id, { path: file.path, body });
    uploaded.push(file.path);
  }

  const index = renderIndex(project.name, uploaded);
  const readme = renderReadme(project.name, uploaded);
  for (const file of [
    { path: 'instructions.md', body: `${STANDING}\n` },
    { path: 'README.md', body: readme },
    { path: 'index.md', body: index },
  ]) {
    log(`upload ${file.path}`);
    await port.putFile(project.id, file);
    uploaded.push(file.path);
  }

  return { project, uploaded };
}

function renderReadme(name, paths) {
  const dataCount = paths.filter((item) => item.startsWith('data/')).length;
  const reportCount = paths.filter((item) => item.startsWith('reports/')).length;
  return [
    name,
    '',
    'Read style-guide.md before writing. Read data/00_README_data_guide.md and data/00_site_profile.json before trusting a number.',
    'The source reports are in reports/. Write the enhanced reports under enhanced/. Do not modify reports/ or style-guide.md.',
    '',
    `- data/ — ${dataCount} files`,
    `- reports/ — ${reportCount} source reports`,
    '- style-guide.md',
    '- enhanced/ — write the three enhanced reports here',
    '',
  ].join('\n');
}

function renderIndex(name, paths) {
  const lines = paths.map((item) => `- ${item}`);
  lines.push('- enhanced/');
  return `# ${name}\n\n${lines.join('\n')}\n`;
}

export { STANDING };
