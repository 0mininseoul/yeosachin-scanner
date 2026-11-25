import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { safePrivate90Observations } from '../tests/analysis/execution/fixtures/private90-observations.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const selector = process.argv[2];
const cloud = selector === '--read-copy';
const synthetic = selector === '--synthetic';
const failure = { status: 'unavailable', code: 'PRIVATE90_FULL_REPLAY_FAILED' };
function execute() {
    if (process.argv.length !== 3 || (!cloud && !synthetic)) return failure;
    if (cloud && (process.env.DEPLOYMENT_ROLE !== 'dev' || !process.env.CLOUD_RUN_JOB)) return failure;
    // No inherited provider credentials, proxy overrides, OAuth keyfiles, original bucket key, or node preload.
    const env = { CI: 'true', TZ: 'UTC', PATH: process.env.PATH, PRIVATE90_FULL_REPLAY: cloud ? 'cloud' : 'synthetic' };
    if (cloud) for (const key of [
        'DEPLOYMENT_ROLE', 'CLOUD_RUN_JOB', 'GOOGLE_CLOUD_PROJECT', 'DEV_LIVE_GCP_PROJECT', 'DEV_LIVE_GCP_PROJECT_NUMBER',
        'DEV_LIVE_STANDARD_TARGET', 'DEV_STANDARD_QA_COPY_APPROVAL', 'DEV_STANDARD_QA_COPY_SOURCE_APPROVAL',
        'DEV_STANDARD_QA_COPY_APPROVED_AT', 'DEV_STANDARD_QA_COPY_DAYS', 'DEV_STANDARD_QA_COPY_PROJECT',
        'DEV_STANDARD_QA_COPY_PROJECT_NUMBER', 'DEV_STANDARD_QA_COPY_BUCKET', 'DEV_STANDARD_QA_COPY_KMS_KEY',
        'DEV_STANDARD_QA_COPY_EXPIRY_SECRET_VERSION',
    ]) {
        if (!process.env[key]) return failure;
        env[key] = process.env[key];
    }
    const guard = path.join(root, 'scripts/dev-standard-private90-egress.cjs');
    const child = spawnSync(process.execPath, [
        '--require', guard, '--max-old-space-size=6144', 'node_modules/vitest/vitest.mjs', 'run',
        '--config', 'tests/analysis/execution/fixtures/private90-vitest.config.ts',
        '-t', cloud ? 'runs the authorized private90 copy' : 'replays a separately sealed copy',
    ], {
        cwd: root, env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 8192,
    });
    const observed = safePrivate90Observations(JSON.parse(child.output?.[3] || 'null'));
    if (child.status !== 0 || observed?.phase !== 'complete') return observed ? { ...failure, ...observed } : failure;
    return { status: 'verified', ...observed };
}
let result;
try { result = execute(); } catch { result = failure; }
console.log(JSON.stringify(result));
if (result.status !== 'verified') process.exitCode = 1;
