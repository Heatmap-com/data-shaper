import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Read one site's full bundle, its reports, and the style guide. Which reports
 * exist comes from the caller (loadReportSpecs reads the report stage
 * descriptors). Paths inside the remote project are provider-neutral.
 *
 * @param {{ slug: string, dataDir: string, reportsDir: string, styleGuide: string, reports: Array<{ role: string, job: string, pattern: RegExp }> }} input
 */
export async function collectSite(input) {
  const slug = input.slug?.trim();
  if (!slug) throw new Error('site is required');
  if (!Array.isArray(input.reports) || input.reports.length === 0) throw new Error('reports are required (see loadReportSpecs)');
  const profilePath = path.join(input.dataDir, '00_site_profile.json');
  let profile;
  try {
    profile = JSON.parse(await readFile(profilePath, 'utf8'));
  } catch (err) {
    throw new Error(`no site profile at ${profilePath} (${err.code ?? err.message})`);
  }
  const dataFiles = await walkFiles(input.dataDir, 'data');
  if (!dataFiles.some((file) => file.remotePath === 'data/00_README_data_guide.md')) {
    throw new Error(`no data guide in ${input.dataDir}`);
  }

  const reportNames = await markdownNames(input.reportsDir);
  const reports = input.reports.map((spec) => {
    const name = reportNames.find((entry) => spec.pattern.test(entry));
    if (!name) throw new Error(`missing ${spec.role} in ${input.reportsDir}`);
    return {
      role: spec.role,
      job: spec.job,
      name,
      sourcePath: `reports/${name}`,
      outputPath: `enhanced/${name}`,
      absolutePath: path.join(input.reportsDir, name),
    };
  });

  let styleBody;
  try {
    styleBody = await readFile(input.styleGuide);
  } catch (err) {
    throw new Error(`no style guide at ${input.styleGuide} (${err.code ?? err.message})`);
  }

  const files = [
    ...dataFiles.map((file) => ({ path: file.remotePath, absolutePath: file.absolutePath })),
    ...reports.map((report) => ({ path: report.sourcePath, absolutePath: report.absolutePath })),
    { path: 'style-guide.md', body: styleBody },
  ];

  const window = profile.report_window;
  const page = profile.analysed_page;
  return {
    slug,
    brand: profile.site || slug,
    domain: profile.domain || slug,
    currency: profile.currency || 'USD',
    window: window ? `${window.start} to ${window.end}` : 'the report window in the site profile',
    analysedPage: page ? `${page.label} (${page.path})` : 'the analysed page in the site profile',
    dataGuide: 'data/00_README_data_guide.md',
    profilePath: 'data/00_site_profile.json',
    anchorsPath: dataFiles.some((file) => file.remotePath === 'data/.anchors.json')
      ? 'data/.anchors.json'
      : 'data/00_site_profile.json',
    notesPath: 'data/10_SITE-NOTES.md',
    styleGuidePath: 'style-guide.md',
    mediaPrefix: '../media/',
    dataFiles: dataFiles.map((file) => file.remotePath),
    reports,
    files,
  };
}

async function markdownNames(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`no reports directory at ${dir} (${err.code ?? err.message})`);
  }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name);
}

async function walkFiles(dir, prefix) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`no data directory at ${dir} (${err.code ?? err.message})`);
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store') continue;
    const absolutePath = path.join(dir, entry.name);
    const remotePath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walkFiles(absolutePath, remotePath)));
    else if (entry.isFile()) files.push({ remotePath, absolutePath });
  }
  return files;
}
