/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = { uploadOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--upload-only') {
      out.uploadOnly = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    if (arg === '--provider') out.provider = value;
    else if (arg === '--site') out.site = value;
    else if (arg === '--data') out.data = value;
    else if (arg === '--reports') out.reports = value;
    else if (arg === '--style-guide') out.styleGuide = value;
    else if (arg === '--out') out.out = value;
    else if (arg === '--stages') out.stages = value;
    else throw new Error(`unknown argument: ${arg}`);
    i += 1;
  }
  return out;
}

export const USAGE = `usage: node scripts/remote-llm-projects/analyze-site.mjs --provider <id> --site <slug> [--upload-only]

--provider       descriptor id (kimi is the first)
--site           site slug, also the project name
--data           full analyst bundle (default ~/work/analysis/<slug>)
--reports        the three source reports (default docs/analysis/<slug>)
--style-guide    report style guide (default docs/style-guide.md)
--out            where enhanced reports are saved (default docs/analysis/<slug>/enhanced)
--stages         stage descriptors that declare the reports (default orchestration/stages)
--upload-only    create the project and upload files, and do not send the prompt

Hosted projects are on https://api.moonshot.cn (the descriptor default). A key for https://api.moonshot.ai cannot create one.
`;
