import { execFile } from 'node:child_process';

/**
 * Runs the configured naming bot command for one page. The command template
 * takes {url} {idsite} {idsitehsr} {botDir}; the child gets the injected
 * environment plus the bot, assets, and container settings from `naming`.
 */

/**
 * @param {string} template
 * @param {Record<string, string>} values
 */
export function substitute(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

/** Minimal shell-word split for configured commands (no quoting escapes). */
export function splitCommand(text) {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * @param {{idsite: number, idsitehsr?: number, url: string}} job
 * @param {{command: string, botDir?: string, assetsDir?: string, container?: string, botTimeoutMs?: number}} naming
 * @param {object} logger
 * @param {NodeJS.ProcessEnv} env the child's base environment
 */
export function runBotCommand(job, naming, logger, env) {
  const substituted = substitute(naming.command, {
    // A raw space in a tracked URL (utm_term=loop earplugs) would split into
    // another argument. encodeURI keeps the query delimiters and encodes the space.
    url: encodeURI(job.url),
    idsite: String(job.idsite),
    idsitehsr: String(job.idsitehsr),
    botDir: naming.botDir ?? '',
  });
  const [cmd, ...args] = splitCommand(substituted);
  return new Promise((resolve, reject) => {
    const childEnv = { ...env };
    if (naming.botDir) childEnv.CNN_AI_BOT_DIR = naming.botDir;
    if (naming.assetsDir) childEnv.NAMING_ENGINE_ASSETS = naming.assetsDir;
    if (naming.container) childEnv.NAMING_CONTAINER = naming.container;
    execFile(cmd, args, { env: childEnv, timeout: naming.botTimeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout) logger.info({ bytes: stdout.length }, 'bot stdout');
      if (err) {
        const timedOut = Boolean(err.killed);
        const outTail = String(stdout ?? '').trim().split('\n').slice(-5).join(' | ');
        const errTail = String(stderr ?? '').trim().split('\n').slice(-5).join(' | ');
        const why = timedOut ? `timed out after ${naming.botTimeoutMs ?? 600_000}ms` : err.message;
        const tail = [errTail, outTail].filter(Boolean).join(' | ');
        reject(new Error(`bot command failed (${cmd} ${args.join(' ')}): ${why}${tail ? `; ${tail}` : ''}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * @typedef {Object} BotRunner
 * @property {(job: object, naming: object, logger: object) => Promise<void>} run
 */

/**
 * @param {{env: NodeJS.ProcessEnv}} deps built in composition
 * @returns {BotRunner}
 */
export function createBotRunner({ env }) {
  return { run: (job, naming, logger) => runBotCommand(job, naming, logger, env) };
}
