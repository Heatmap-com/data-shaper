import { writeFileSync } from 'node:fs';

const out = process.env.ECHO_ARGS_OUT;
writeFileSync(out, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write('worker log line\n');
