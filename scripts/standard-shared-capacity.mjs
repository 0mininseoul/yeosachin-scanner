import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedStandardCapacity } from '../tests/analysis/execution/fixtures/standard-shared-capacities.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [owners = '16', preset = '8', scenario = 'normal', receipt, publicCount = '1', timing = 'fast', tail = 'immediate', delivery = 'fixture', option, ...rest] =
    process.argv.slice(2);
const apifyHeadroom = option === '--apify-headroom=7';
const paidPlan = process.env.SHARED_STANDARD_PLAN ?? 'standard';
const budgetProbe = apifyHeadroom ? undefined : option;
const capacity = sharedStandardCapacity(preset);
const graceByStrategy = { immediate: '0', grace8s: '8000', finish50s: '50000', coverage99: '0' };

if (rest.length || !['standard', 'plus'].includes(paidPlan) || !/^(?:[1-9]|1[0-6])$/.test(owners) || !['normal', 'recovery'].includes(scenario)
    || !/^[1-9][0-9]{0,2}$/.test(publicCount) || Number(publicCount) > (paidPlan === 'plus' ? 900 : 600)
    || !['fixture', 'production-paid'].includes(delivery)
    || ('processFeatureSlots' in capacity && delivery !== 'production-paid')
    || (tail === 'coverage99' && (scenario !== 'recovery' || Number(publicCount) < 4))
    || (apifyHeadroom && (owners !== '6' || publicCount !== '600' || delivery !== 'production-paid'))
    || (budgetProbe !== undefined && (!['held', 'spent'].includes(budgetProbe) || owners !== '1' || publicCount !== '4'
        || delivery !== 'production-paid' || timing !== 'fast'))
    || (delivery === 'production-paid' && paidPlan === 'standard' && (capacity.slots !== 128 || tail !== 'coverage99'))
    || (paidPlan === 'plus' && (delivery !== 'production-paid' || capacity.slots !== 8 || !['2', '3'].includes(owners) || publicCount !== '900' || Boolean(option)))
    || !Object.hasOwn(graceByStrategy, tail) || !['fast', 'observed'].includes(timing) || (receipt && !path.isAbsolute(receipt))) {
    throw new Error('Usage: node scripts/standard-shared-capacity.mjs [1..16] [capacity preset] [normal|recovery] '
        + '[absolute-new-receipt.json] [1..600 public candidates] [fast|observed] [immediate|grace8s|finish50s|coverage99] [fixture|production-paid] [held|spent|--apify-headroom=7]');
}

const test = [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config',
    'tests/analysis/execution/fixtures/standard-shared-vitest.config.ts', ...(receipt ? ['--silent'] : [])];
// The child needs a Unix socket for PostgreSQL. Deny IP traffic before loading application modules.
const sandbox = {
    darwin: ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network-outbound (remote ip))(deny network-bind (local ip))'],
    linux: ['unshare', '--net', '--'],
}[process.platform];
if (!sandbox) throw new Error('Isolated network execution requires macOS or Linux.');

// Identify the tracked code actually measured; dirty worktrees must not claim a commit's results.
const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' });
const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
const sourceRevision = head.status === 0 && status.status === 0 && !status.stdout.trim() ? head.stdout.trim() : undefined;
const env = {
    ...(sourceRevision ? { SHARED_STANDARD_SOURCE_REVISION: sourceRevision } : {}),
    PATH: process.env.PATH,
    CI: 'true',
    TZ: 'UTC',
    NODE_ENV: 'test',
    SHARED_STANDARD_OWNERS: owners,
    SHARED_STANDARD_WORKERS: String(capacity.workers),
    SHARED_STANDARD_PRESET: preset,
    STANDARD_SHARED_VERTEX_SLOTS: String(capacity.slots),
    SHARED_STANDARD_SCENARIO: scenario,
    SHARED_STANDARD_DELIVERY: delivery,
    SHARED_STANDARD_PLAN: paidPlan,
    SHARED_STANDARD_PUBLIC: publicCount,
    SHARED_STANDARD_TIMING: timing,
    STANDARD_SHARED_RESOLVER_GRACE_MS: graceByStrategy[tail],
    ...(tail === 'coverage99' && delivery === 'fixture' ? { DEV_LIVE_STANDARD_RESOLVER_MODE: 'admitted' } : {}),
    ...(apifyHeadroom ? { SHARED_STANDARD_APIFY_HEADROOM: '7' } : {}),
    ...(budgetProbe ? { SHARED_STANDARD_BUDGET_PROBE: budgetProbe } : {}),
    ...(receipt ? { SHARED_STANDARD_RECEIPT: receipt } : {}),
};
const result = spawnSync(sandbox[0], [...sandbox.slice(1), ...test], { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
