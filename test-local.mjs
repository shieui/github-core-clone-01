// test-local.mjs — start the forge on an ephemeral port and run the kit suite
// against it. Usage: node test-local.mjs [--perf] [--json] [--groups git,rest,...]
// The token is a fixed test value; MAKEFUN_SHOP_TOKEN is set to it for the server.
import { spawn } from 'node:child_process';
import { createApp } from './app.ts';

const TOKEN = 'shpat_test00000000000000000000000000000000';
process.env.MAKEFUN_SHOP_TOKEN = TOKEN;

const args = process.argv.slice(2);
const server = createApp();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}`;
console.log(`forge listening on ${url}`);

const runArgs = [
  '--experimental-strip-types',
  '/home/hatch/workspace/makefun/github-core-clone-01-kit/sdk/run.ts',
  '--url', url,
  '--token', TOKEN,
  ...args,
];
const child = spawn('node', runArgs, { stdio: 'inherit' });
const code = await new Promise((resolve) => child.on('exit', resolve));
server.close();
process.exit(code ?? 1);
