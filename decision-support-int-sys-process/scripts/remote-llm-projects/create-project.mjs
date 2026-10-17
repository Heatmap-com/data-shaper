import { pathToFileURL } from 'node:url';
import { parseArgs, USAGE } from './args.mjs';
import { createProject } from './application/create-project.mjs';
import { loadProjectPort } from './load-port.mjs';

export async function main(argv, deps = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.provider || !args.name) {
    console.error('provider and name are required');
    console.error(USAGE);
    return 2;
  }
  try {
    const port = await loadProjectPort(args.provider, deps);
    const project = await createProject(port, { name: args.name, instructions: args.instructions });
    console.log(JSON.stringify({ provider: args.provider, ...project }, null, 2));
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
