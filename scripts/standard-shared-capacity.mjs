import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedStandardCapacity } from '../tests/analysis/execution/fixtures/standard-shared-capacities.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [owners = '16', preset = '8', scenario = 'normal', receipt, publicCount = '1', timing = 'fast', tail = 'immediate', ...rest] =
    process.argv.slice(2);
const capacity = sharedStandardCapacity(preset);
const graceByStrategy = { immediate: '0', grace8s: '8000', finish50s: '50000' };

if (rest.length || !['2', '16'].includes(owners) || !['normal', 'recovery'].includes(scenario)
    || !/^[1-9][0-9]{0,2}$/.test(publicCount) || Number(publicCount) > 240
    || !Object.hasOwn(graceByStrategy, tail) || !['fast', 'observed'].includes(timing) || (receipt && !path.isAbsolute(receipt))) {
    throw new Error('Usage: node scripts/standard-shared-capacity.mjs [2|16] [capacity preset] [normal|recovery] '
        + '[absolute-new-receipt.json] [1..240 public candidates] [fast|observed] [immediate|grace8s|finish50s]');
}

const test = [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config',
    'tests/analysis/execution/fixtures/standard-shared-vitest.config.ts', ...(receipt ? ['--silent'] : [])];
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
    SHARED_STANDARD_WORKERS: String(capacity.workers),
    SHARED_STANDARD_PRESET: preset,
    STANDARD_SHARED_VERTEX_SLOTS: String(capacity.slots),
    SHARED_STANDARD_SCENARIO: scenario,
    SHARED_STANDARD_PUBLIC: publicCount,
    SHARED_STANDARD_TIMING: timing,
    STANDARD_SHARED_RESOLVER_GRACE_MS: graceByStrategy[tail],
    ...(receipt ? { SHARED_STANDARD_RECEIPT: receipt } : {}),
};
const result = spawnSync(sandbox[0], [...sandbox.slice(1), ...test], { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
