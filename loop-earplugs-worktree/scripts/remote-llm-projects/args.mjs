/**
 * @param {string[]} argv
 * @returns {{ help?: boolean, provider?: string, name?: string, instructions?: string }}
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} needs a value`);
    }
    if (arg === '--provider') out.provider = value;
    else if (arg === '--name') out.name = value;
    else if (arg === '--instructions') out.instructions = value;
    else throw new Error(`unknown argument: ${arg}`);
    i += 1;
  }
  return out;
}

export const USAGE = `usage: node scripts/remote-llm-projects/create-project.mjs --provider <id> --name <name> [--instructions <text>]

--provider   descriptor id (kimi is the first)
--name       project name
--instructions   standing instructions stored with the project
`;
