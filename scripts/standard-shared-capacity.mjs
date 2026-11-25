import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [owners = '16', slots = '8', scenario = 'normal', receipt, publicCount = '1', timing = 'fast', ...rest] =
    process.argv.slice(2);
const workerCounts = new Map([['8', '8'], ['48', '16'], ['56', '20']]);
const workers = workerCounts.get(slots);

if (rest.length || !['2', '16'].includes(owners) || !workers || !['normal', 'recovery'].includes(scenario)
    || !/^[1-9][0-9]{0,2}$/.test(publicCount) || Number(publicCount) > 240
    || !['fast', 'observed'].includes(timing) || (receipt && !path.isAbsolute(receipt))) {
    throw new Error('Usage: node scripts/standard-shared-capacity.mjs [2|16] [8|48|56] [normal|recovery] '
        + '[absolute-new-receipt.json] [1..240 public candidates] [fast|observed]');
}

const test = [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config',
    'tests/analysis/execution/fixtures/standard-shared-vitest.config.ts'];
// The child needs a Unix socket for PostgreSQL. Deny IP traffic before loading application modules.
const sandbox = {
    darwin: ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-bind (local ip))'],
    linux: ['unshare', '--net', '--'],
}[process.platform];
if (!sandbox) throw new Error('Isolated network execution requires macOS or Linux.');

const env = {
    PATH: process.env.PATH,
    CI: 'true',
    TZ: 'UTC',
    NODE_ENV: 'test',
    SHARED_STANDARD_OWNERS: owners,
    SHARED_STANDARD_WORKERS: workers,
    STANDARD_SHARED_VERTEX_SLOTS: slots,
    SHARED_STANDARD_SCENARIO: scenario,
    SHARED_STANDARD_PUBLIC: publicCount,
    SHARED_STANDARD_TIMING: timing,
    ...(receipt ? { SHARED_STANDARD_RECEIPT: receipt } : {}),
};
const result = spawnSync(sandbox[0], [...sandbox.slice(1), ...test], { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
