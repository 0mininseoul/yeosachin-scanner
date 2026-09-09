import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const KNOWN_PREFLIGHT_OLD_SOURCE_SHA = '3b28e55c8877276557f8a5a218fb2b966376d889';
const KNOWN_PAID_OLD_SOURCE_SHA = '3b28e55c8877276557f8a5a218fb2b966376d889';
const PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION = 'preflight-producer-config-v1';
const PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION = 'paid-producer-config-v1';
// Sanitized fixture identities for the initial-stage service-account
// roll-forward.  These are deliberately synthetic; no real production service
// account, project, or source SHA ever appears in this suite.
const OLD_IDENTITY_SOURCE_SHA = 'c'.repeat(40);
// The recovery scheduler must have been PAUSED for longer than the deployed
// Cloud Run request timeout plus grace before the queue can be trusted empty.
const PREFLIGHT_RECOVERY_QUIESCENCE_SECONDS = 660;
function agedPauseEpoch(agoSeconds = PREFLIGHT_RECOVERY_QUIESCENCE_SECONDS + 240): string {
    return String(Math.floor(Date.now() / 1000) - agoSeconds);
}
const OLD_IDENTITIES = {
    preflight: {
        task: 'preflight-task-legacy@example-project.iam.gserviceaccount.com',
        runtime: 'preflight-runtime-legacy@example-project.iam.gserviceaccount.com',
    },
    paid: {
        task: 'paid-task-legacy@example-project.iam.gserviceaccount.com',
        runtime: 'paid-runtime-legacy@example-project.iam.gserviceaccount.com',
    },
} as const;
// Every child command in this contract suite is deliberately bounded.  The
// suite exercises shell wrappers, so an accidentally waiting fake command must
// fail the test deterministically instead of leaving Vitest's worker RPC
// pending behind a synchronous child process.
// Full-repository Vitest workers can briefly contend for CPU while each fake
// shell launches several bounded adapters. Keep this fixture deadline finite,
// but leave enough room for that expected scheduling pressure.
const CHILD_PROCESS_TIMEOUT_MS = 60_000;
const CHILD_PROCESS_TERM_GRACE_MS = 2_000;
const CHILD_PROCESS_REAP_TIMEOUT_MS = 5_000;

function reapProcessTree(pid: number | undefined): void {
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return;
    const processGroup = -(pid as number);
    const isAlive = (): boolean => {
        try {
            process.kill(processGroup, 0);
            return true;
        } catch {
            return false;
        }
    };
    const waitForExit = (deadlineMs: number): boolean => {
        const deadline = Date.now() + deadlineMs;
        while (isAlive() && Date.now() < deadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
        return !isAlive();
    };
    try { process.kill(processGroup, 'SIGTERM'); } catch { /* already exited */ }
    if (waitForExit(CHILD_PROCESS_TERM_GRACE_MS)) return;
    try { process.kill(processGroup, 'SIGKILL'); } catch { /* already exited */ }
    if (!waitForExit(CHILD_PROCESS_REAP_TIMEOUT_MS)) {
        throw new Error('fixture child process tree did not terminate within the bounded reap deadline');
    }
}

function producerConfigFingerprint(
    environment: Record<string, string>,
    role: 'preflight' | 'paid',
): string {
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const targetPath = role === 'preflight'
        ? '/api/analysis/preflight/worker'
        : '/api/analysis/v2/worker';
    const version = role === 'preflight'
        ? PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION
        : PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION;
    return createHash('sha256').update([
        version,
        environment[`${prefix}_SERVICE_ACCOUNT_EMAIL`].trim().toLowerCase(),
        new URL(environment[`${prefix}_TARGET_URL`].trim()).origin.toLowerCase() + targetPath,
        new URL(environment[`${prefix}_OIDC_AUDIENCE`].trim()).origin.toLowerCase(),
    ].join('\n'), 'utf8').digest('hex');
}

function baseEnvironment(role: 'preflight' | 'paid' = 'preflight') {
    const preflight = {
        PREFLIGHT_TASKS_PROJECT: 'example-project',
        PREFLIGHT_TASKS_LOCATION: 'asia-northeast3',
        PREFLIGHT_TASKS_QUEUE: 'analysis-preflight',
        PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/preflight/worker',
        PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
        PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
        PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL: 'preflight-enqueuer@example-project.iam.gserviceaccount.com',
        PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL: 'preflight-runtime@example-project.iam.gserviceaccount.com',
        PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL: 'preflight-maintenance@example-project.iam.gserviceaccount.com',
        PREFLIGHT_TASKS_MAINTENANCE_OIDC_AUDIENCE: 'https://preflight.example.com',
        PREFLIGHT_TASKS_RECOVERY_ENABLED: 'true',
        PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB: 'analysis-preflight-recovery',
        PREFLIGHT_TASKS_CLOUD_RUN_SERVICE: 'analysis-preflight-worker',
        PREFLIGHT_TASKS_CLOUD_RUN_REGION: 'asia-northeast3',
    };
    const paid = {
        ANALYSIS_V2_TASKS_PROJECT: 'example-project',
        ANALYSIS_V2_TASKS_LOCATION: 'asia-northeast3',
        ANALYSIS_V2_TASKS_QUEUE: 'analysis-v2-pipeline',
        ANALYSIS_V2_TASKS_TARGET_URL: 'https://paid.example.com/api/analysis/v2/worker',
        ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://paid.example.com',
        ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: 'paid-task@example-project.iam.gserviceaccount.com',
        ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL: 'paid-enqueuer@example-project.iam.gserviceaccount.com',
        ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL: 'paid-runtime@example-project.iam.gserviceaccount.com',
        ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL: 'paid-maintenance@example-project.iam.gserviceaccount.com',
        ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE: 'https://paid.example.com',
        ANALYSIS_V2_RECOVERY_ENABLED: 'true',
        ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE: 'analysis-paid-worker',
        ANALYSIS_V2_TASKS_CLOUD_RUN_REGION: 'asia-northeast3',
    };
    return {
        ...preflight,
        ...paid,
        ANALYSIS_WORKLOAD_ROLE: role,
        ANALYSIS_CAPACITY_ROLE: role,
        ANALYSIS_CAPACITY_STAGE: 'initial',
        ANALYSIS_CAPACITY_EXPANSION_CANARY: 'false',
        ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
        ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
        ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED: 'true',
        ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED: 'true',
        ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED: 'true',
        ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
        ANALYSIS_CAPACITY_PUBLIC_FREEZE_READINESS_URL: 'https://public.example.com/api/analysis/capacity/readiness',
        ANALYSIS_CAPACITY_LEGACY_QUEUE_PROJECT: 'example-project',
        ANALYSIS_CAPACITY_LEGACY_QUEUE_LOCATION: 'asia-northeast3',
        ANALYSIS_CAPACITY_LEGACY_QUEUE: 'analysis-pipeline',
        ANALYSIS_CAPACITY_LEGACY_TARGET_URL: 'https://public.example.com/api/analysis/start',
        ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
        ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET: 'analysis-capacity-lock-fixture',
        VERCEL_PROJECT_ID: 'fixture-project',
        VERCEL_TOKEN: 'vercel-token-fixture',
        VERCEL_API_BASE_URL: 'https://api.vercel.test',
        VERCEL_TEAM_ID: 'fixture-team',
        ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true',
        ANALYSIS_BETA_PREPARE_ENABLED: 'false',
        ANALYSIS_CAPACITY_SOURCE_DIR: '.',
        ANALYSIS_V2_APIFY_API_TOKEN_SLOT: role === 'paid' ? 'secondary' : 'senary',
        PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,tertiary,quaternary,quinary,senary,septenary,octonary,nonary,tenth',
        ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION: '7',
        ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION: '7',
        ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION: '7',
        ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION: '7',
        ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION: '7',
        ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS: role === 'paid'
            ? 'primary:7,tertiary:7,quaternary:7,quinary:7,senary:7,septenary:7,octonary:7,nonary:7,tenth:7'
            : 'primary:7,tertiary:7,quaternary:7,quinary:7,septenary:7,octonary:7,nonary:7,tenth:7',
        ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT: 'analysis-build@example-project.iam.gserviceaccount.com',
        GITHUB_TOKEN: 'github-token-fixture',
        // fakeRun spreads process.env before this fixture, so the exceptional
        // roll-forward assertions must be blanked explicitly.  Otherwise a
        // developer or orchestrator shell that exports them would silently
        // change what the ordinary-path tests exercise.
        ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL: '',
        ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_ENQUEUER_SERVICE_ACCOUNT_EMAIL: '',
        ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_RUNTIME_SERVICE_ACCOUNT_EMAIL: '',
        ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_SOURCE_SHA: '',
        ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH: '',
    };
}

function manifestFor(
    role: 'preflight' | 'paid',
    overrides: Record<string, unknown> = {},
    environmentOverrides: Record<string, string> = {},
) {
    const env = { ...baseEnvironment(role), ...environmentOverrides };
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const stage = (overrides.ANALYSIS_CAPACITY_STAGE as string | undefined) ?? 'initial';
    const expansionCanary = (overrides.ANALYSIS_CAPACITY_EXPANSION_CANARY as string | undefined) ?? 'false';
    const active = stage !== 'bootstrap';
    const recoveryGate = role === 'preflight'
        ? 'PREFLIGHT_TASKS_RECOVERY_ENABLED'
        : 'ANALYSIS_V2_RECOVERY_ENABLED';
    const maintenancePrefix = role === 'preflight'
        ? 'PREFLIGHT_TASKS'
        : 'ANALYSIS_V2';
    return {
        [`${prefix}_PROJECT`]: env[`${prefix}_PROJECT` as keyof typeof env],
        [`${prefix}_LOCATION`]: env[`${prefix}_LOCATION` as keyof typeof env],
        [`${prefix}_QUEUE`]: env[`${prefix}_QUEUE` as keyof typeof env],
        [`${prefix}_TARGET_URL`]: env[`${prefix}_TARGET_URL` as keyof typeof env],
        [`${prefix}_OIDC_AUDIENCE`]: env[`${prefix}_OIDC_AUDIENCE` as keyof typeof env],
        [`${prefix}_SERVICE_ACCOUNT_EMAIL`]: env[`${prefix}_SERVICE_ACCOUNT_EMAIL` as keyof typeof env],
        [`${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL`]: env[`${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL` as keyof typeof env],
        [`${maintenancePrefix}_MAINTENANCE_OIDC_AUDIENCE`]: env[`${maintenancePrefix}_MAINTENANCE_OIDC_AUDIENCE` as keyof typeof env],
        [recoveryGate]: active ? 'true' : 'false',
        ANALYSIS_WORKLOAD_ROLE: role,
        ANALYSIS_CAPACITY_STAGE: stage,
        ANALYSIS_CAPACITY_EXPANSION_CANARY: expansionCanary,
        ANALYSIS_CAPACITY_WORKER_CPU: '2',
        ANALYSIS_CAPACITY_WORKER_MEMORY: '2Gi',
        ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: active ? 'true' : 'false',
        ANALYSIS_V2_APIFY_API_TOKEN_SLOT: env.ANALYSIS_V2_APIFY_API_TOKEN_SLOT,
        ...(role === 'preflight'
            ? { PREFLIGHT_APIFY_API_TOKEN_SLOTS: env.PREFLIGHT_APIFY_API_TOKEN_SLOTS }
            : {}),
        ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: active ? 'drain-and-block' : 'bootstrap',
        ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: active ? 'true' : 'false',
        ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED: active ? 'true' : 'false',
        ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED: active ? 'true' : 'false',
        ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED: active ? 'true' : 'false',
        ANALYSIS_PROVIDER_ADMISSION_ENABLED: active ? 'true' : 'false',
        ANALYSIS_BETA_PREPARE_ENABLED: 'false',
        PREFLIGHT_TASKS_ENABLED: role === 'preflight' && active ? 'true' : 'false',
        ANALYSIS_V2_TASKS_ENABLED: role === 'paid' && active ? 'true' : 'false',
        ANALYSIS_V2_WORKER_ENABLED: role === 'paid' && active ? 'true' : 'false',
        PREFLIGHT_TASKS_RECOVERY_ENABLED: role === 'preflight' && active ? 'true' : 'false',
        ANALYSIS_V2_RECOVERY_ENABLED: role === 'paid' && active ? 'true' : 'false',
        ...overrides,
    };
}

function deepMerge<T>(base: T, override: unknown): T {
    if (Array.isArray(base) && Array.isArray(override)) {
        if (override.every((entry) => entry && typeof entry === 'object' && 'name' in entry)) {
            const merged = [...base] as unknown[];
            for (const entry of override) {
                const name = (entry as { name: string }).name;
                const index = merged.findIndex((candidate) => (
                    candidate && typeof candidate === 'object' && (candidate as { name?: string }).name === name
                ));
                if (index < 0) merged.push(entry);
                else merged[index] = deepMerge(merged[index], entry);
            }
            return merged as T;
        }
        return override.map((entry, index) => (
            index < base.length ? deepMerge(base[index], entry) : entry
        )) as T;
    }
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
        return (override as T) ?? base;
    }
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
        return override as T;
    }
    const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
        merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged as T;
}

function runQueue(script: string, args: string[], extra: Record<string, string> = {}): string {
    const env = baseEnvironment((extra.ANALYSIS_CAPACITY_ROLE as 'preflight' | 'paid') ?? 'preflight');
    const fixtureDir = mkdtempSync(join(tmpdir(), 'capacity-infra-'));
    const manifestPath = join(fixtureDir, 'runtime.json');
    const buildManifestPath = join(fixtureDir, 'build.json');
    const role = (extra.ANALYSIS_CAPACITY_ROLE as 'preflight' | 'paid') ?? 'preflight';
    const manifestOverrides = Object.fromEntries(
        Object.entries({
            ANALYSIS_CAPACITY_STAGE: extra.ANALYSIS_CAPACITY_STAGE,
            ANALYSIS_CAPACITY_EXPANSION_CANARY: extra.ANALYSIS_CAPACITY_EXPANSION_CANARY,
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: extra.ANALYSIS_CAPACITY_STAGE === 'bootstrap' ? 'false' : 'true',
        }).filter(([, value]) => value !== undefined),
    );
    writeFileSync(manifestPath, JSON.stringify(manifestFor(role, manifestOverrides)));
    writeFileSync(buildManifestPath, JSON.stringify({
        NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key-fixture',
    }));
    const sourceDir = script === 'deploy-analysis-capacity-workers.sh'
        ? join(fixtureDir, 'source')
        : '.';
    if (script === 'deploy-analysis-capacity-workers.sh') {
        execFileSync('git', ['clone', '--quiet', '--no-local', root, sourceDir], {
            cwd: root,
            encoding: 'utf8',
            timeout: CHILD_PROCESS_TIMEOUT_MS,
        });
    }
    try {
        return execFileSync('bash', [`scripts/${script}`, ...args], {
            cwd: root,
            env: {
                ...process.env,
                ...env,
                ...(script === 'deploy-analysis-capacity-workers.sh'
                    ? {
                        ANALYSIS_CAPACITY_SOURCE_DIR: sourceDir,
                        ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: extra.ANALYSIS_CAPACITY_STAGE === 'bootstrap' ? 'false' : 'true',
                    }
                    : {}),
                ANALYSIS_CAPACITY_ENV_VARS_FILE: manifestPath,
                ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE: buildManifestPath,
                ...extra,
            },
            encoding: 'utf8',
            timeout: CHILD_PROCESS_TIMEOUT_MS,
        });
    } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
    }
}

interface FakeRunOptions {
    role?: 'preflight' | 'paid';
    stage?: 'bootstrap' | 'initial' | 'expanded';
    serviceStage?: 'bootstrap' | 'initial' | 'expanded';
    observedSourceSha?: string;
    stagedSourceSha?: string;
    postDeploySourceSha?: string;
    stagedTraffic?: 'none' | 'zero-percent' | 'real-change';
    serviceResourceShape?: 'missing' | 'wrong-cpu' | 'wrong-memory' | 'legacy-top-level-only';
    serviceOverrides?: Record<string, unknown>;
    serviceEnv?: Record<string, string | null>;
    environment?: Record<string, string>;
    omitMinScaleAnnotation?: boolean;
    iam?: Record<string, unknown>;
    manifestOverrides?: Record<string, unknown>;
    readiness?: Record<string, unknown>;
    args?: readonly string[];
    revisionService?: string;
    vercelDeployments?: unknown;
    vercelAliases?: unknown;
    vercelProjectEnvironment?: unknown;
    queueTasks?: unknown;
    targetQueue?: Record<string, unknown> | 'unobservable';
    // Each identity is switched independently so staged and post-promotion
    // exactness is proven separately for the task caller, the enqueuer, and the
    // runtime identity rather than through one combined toggle.
    deploySkipsIdentity?: 'task' | 'enqueuer' | 'runtime';
    postDeployIdentityDrift?: { field: 'task' | 'enqueuer' | 'runtime'; value: string };
    schedulerJob?: Record<string, unknown> | 'unobservable';
    // jq patch applied to the service fixture before it is written. deepMerge
    // treats null/undefined overrides as "keep base", so an explicitly absent or
    // null field can only be expressed this way.
    serviceJsonPatch?: string;
    // Simulates a rejected write (e.g. an etag conflict) so the no-retry
    // contract can be observed.
    failSetIamPolicy?: boolean;
    // Sequence-aware races: the Nth read still returns the pre-drift fixture and
    // the drift lands immediately afterwards, so a later read observes it.
    serviceDriftAfterReads?: { afterReads: number; patch: string };
    iamDriftAfterReads?: { afterReads: number; patch: string };
    // Applied to the IAM fixture by the fake set-iam-policy, modelling a server
    // that accepted the write but returns something other than what was sent.
    postSetIamPatch?: string;
    publicFreeze?: Record<string, unknown>;
}

function fakeRun(options: FakeRunOptions = {}) {
    const role = options.role ?? 'paid';
    const env = { ...baseEnvironment(role), ...(options.environment ?? {}) };
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const maintenancePrefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2';
    const target = env[`${prefix}_TARGET_URL` as keyof typeof env] as string;
    const origin = target.replace(role === 'preflight'
        ? '/api/analysis/preflight/worker'
        : '/api/analysis/v2/worker', '');
    const taskServiceAccount = env[`${prefix}_SERVICE_ACCOUNT_EMAIL` as keyof typeof env] as string;
    const runtime = env[role === 'preflight'
        ? 'PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL'
        : 'ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL'] as string;
    const stage = options.stage ?? 'initial';
    const serviceStage = options.serviceStage ?? stage;
    const expansionCanary = stage === 'expanded' ? 'true' : 'false';
    const active = stage !== 'bootstrap';
    const serviceExpansionCanary = serviceStage === 'expanded' ? 'true' : 'false';
    const serviceActive = serviceStage !== 'bootstrap';
    const maxScale = serviceStage === 'expanded' ? (role === 'preflight' ? '64' : '16') : (role === 'preflight' ? '32' : '8');
    const queue = env[`${prefix}_QUEUE` as keyof typeof env] as string;
    const service = env[`${prefix}_CLOUD_RUN_SERVICE` as keyof typeof env] as string;
    const fixtureDir = mkdtempSync(join(tmpdir(), 'capacity-fake-gcloud-'));
    let childPid: number | undefined;
    let childTreeReaped = false;
    const sourceDir = join(fixtureDir, 'source');
    execFileSync('git', ['clone', '--quiet', '--no-local', root, sourceDir], {
        cwd: root,
        encoding: 'utf8',
        timeout: CHILD_PROCESS_TIMEOUT_MS,
    });
    const sourceCommit = execFileSync(
        'git',
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        { cwd: root, encoding: 'utf8', timeout: CHILD_PROCESS_TIMEOUT_MS },
    ).trim();
    const observedSourceSha = options.observedSourceSha ?? sourceCommit;
    const githubPath = join(fixtureDir, 'github.json');
    writeFileSync(githubPath, JSON.stringify({
        total_count: 1,
        workflow_runs: [{
            path: '.github/workflows/ci.yml',
            head_sha: sourceCommit,
            event: 'push',
            head_branch: 'main',
            status: 'completed',
            conclusion: 'success',
        }],
    }));
    const secretEnv = (role === 'preflight'
        ? [
            ['APIFY_PRIMARY_API_TOKEN', 'ai-baram-v2-apify-primary', '7'],
            ['APIFY_TERTIARY_API_TOKEN', 'ai-baram-v2-apify-tertiary', '7'],
            ['APIFY_QUATERNARY_API_TOKEN', 'ai-baram-v2-apify-quaternary', '7'],
            ['APIFY_QUINARY_API_TOKEN', 'ai-baram-v2-apify-quinary', '7'],
            ['APIFY_SENARY_API_TOKEN', 'ai-baram-v2-apify-senary', '7'],
            ['APIFY_SEPTENARY_API_TOKEN', 'ai-baram-v2-apify-septenary', '7'],
            ['APIFY_OCTONARY_API_TOKEN', 'ai-baram-v2-apify-octonary', '7'],
            ['APIFY_NONARY_API_TOKEN', 'ai-baram-v2-apify-nonary', '7'],
            ['APIFY_TENTH_API_TOKEN', 'ai-baram-v2-apify-tenth', '7'],
        ]
        : [
            ['APIFY_PRIMARY_API_TOKEN', 'ai-baram-v2-apify-primary', '7'],
            ['APIFY_SECONDARY_API_TOKEN', 'ai-baram-v2-apify-secondary', '7'],
            ['APIFY_TERTIARY_API_TOKEN', 'ai-baram-v2-apify-tertiary', '7'],
            ['APIFY_QUATERNARY_API_TOKEN', 'ai-baram-v2-apify-quaternary', '7'],
            ['APIFY_QUINARY_API_TOKEN', 'ai-baram-v2-apify-quinary', '7'],
            ['APIFY_SENARY_API_TOKEN', 'ai-baram-v2-apify-senary', '7'],
            ['APIFY_SEPTENARY_API_TOKEN', 'ai-baram-v2-apify-septenary', '7'],
            ['APIFY_OCTONARY_API_TOKEN', 'ai-baram-v2-apify-octonary', '7'],
            ['APIFY_NONARY_API_TOKEN', 'ai-baram-v2-apify-nonary', '7'],
            ['APIFY_TENTH_API_TOKEN', 'ai-baram-v2-apify-tenth', '7'],
    ]).concat([
        ['SUPABASE_SERVICE_ROLE_KEY', 'ai-baram-v2-supabase-service-role', '7'],
        ['IMAGE_PROXY_SIGNING_SECRET', 'ai-baram-v2-image-proxy-signing', '7'],
        ['ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET', 'ai-baram-v2-preflight-identity-hmac', '7'],
        ['ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET', 'ai-baram-v2-gender-routing-hmac', '7'],
    ]).map(([name, secretName, version]) => ({
        name,
        valueFrom: { secretKeyRef: { name: secretName, key: version } },
    }));
    const configuredSecretVersions = new Map<string, string>([
        ['SUPABASE_SERVICE_ROLE_KEY', env.ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION],
        ['IMAGE_PROXY_SIGNING_SECRET', env.ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION],
        ['ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET', env.ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION],
        ['ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET', env.ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION],
    ]);
    const selectedSlot = env.ANALYSIS_V2_APIFY_API_TOKEN_SLOT;
    configuredSecretVersions.set(
        `APIFY_${selectedSlot.toUpperCase()}_API_TOKEN`,
        env.ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION,
    );
    for (const entry of env.ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS.split(',')) {
        const [slot, version] = entry.split(':');
        if (slot && version) configuredSecretVersions.set(`APIFY_${slot.toUpperCase()}_API_TOKEN`, version);
    }
    for (const entry of secretEnv) {
        const configuredVersion = configuredSecretVersions.get(entry.name);
        if (configuredVersion) entry.valueFrom.secretKeyRef.key = configuredVersion;
    }
    const serviceJsonDefaults = {
        status: {
            url: origin,
            latestReadyRevisionName: `${service}-00001-abc`,
            latestCreatedRevisionName: `${service}-00001-abc`,
            conditions: [{ type: 'Ready', status: 'True' }],
            traffic: [{ revisionName: `${service}-00001-abc`, percent: 100 }],
        },
        metadata: {
            name: service,
            resourceVersion: 'rv-fixture-0001',
            generation: 7,
            labels: {
                'analysis-workload-role': role,
                'analysis-capacity-stage': serviceStage,
                'analysis-v2-source-commit': observedSourceSha,
            },
        },
        spec: {
            template: {
                metadata: {
                    annotations: {
                        'autoscaling.knative.dev/maxScale': maxScale,
                        'autoscaling.knative.dev/minScale': '0',
                    },
                    labels: {
                        'analysis-v2-source-commit': observedSourceSha,
                    },
                },
                spec: {
                    serviceAccountName: runtime,
                    containerConcurrency: 1,
                    timeoutSeconds: 600,
                    containers: [{
                        image: 'asia-northeast3-docker.pkg.dev/example-project/cloud-run-source-deploy/analysis-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        resources: { limits: { cpu: '2', memory: '2Gi' } },
                        env: [
                            { name: `${prefix}_PROJECT`, value: env[`${prefix}_PROJECT` as keyof typeof env] },
                            { name: `${prefix}_LOCATION`, value: env[`${prefix}_LOCATION` as keyof typeof env] },
                            { name: `${prefix}_QUEUE`, value: queue },
                            { name: `${prefix}_TARGET_URL`, value: target },
                            { name: `${prefix}_OIDC_AUDIENCE`, value: env[`${prefix}_OIDC_AUDIENCE` as keyof typeof env] },
                            { name: `${prefix}_SERVICE_ACCOUNT_EMAIL`, value: taskServiceAccount },
                            { name: `${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL`, value: env[`${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL` as keyof typeof env] },
                            { name: `${maintenancePrefix}_MAINTENANCE_OIDC_AUDIENCE`, value: env[`${maintenancePrefix}_MAINTENANCE_OIDC_AUDIENCE` as keyof typeof env] },
                            { name: 'PREFLIGHT_TASKS_RECOVERY_ENABLED', value: role === 'preflight' && serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_V2_RECOVERY_ENABLED', value: role === 'paid' && serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_WORKLOAD_ROLE', value: role },
                            { name: 'ANALYSIS_CAPACITY_STAGE', value: serviceStage },
                            { name: 'ANALYSIS_CAPACITY_EXPANSION_CANARY', value: serviceExpansionCanary },
                            { name: 'ANALYSIS_CAPACITY_WORKER_CPU', value: '2' },
                            { name: 'ANALYSIS_CAPACITY_WORKER_MEMORY', value: '2Gi' },
                            { name: 'ANALYSIS_V2_APIFY_API_TOKEN_SLOT', value: env.ANALYSIS_V2_APIFY_API_TOKEN_SLOT },
                            ...(role === 'preflight'
                                ? [{ name: 'PREFLIGHT_APIFY_API_TOKEN_SLOTS', value: env.PREFLIGHT_APIFY_API_TOKEN_SLOTS }]
                                : []),
                            { name: 'ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE', value: serviceActive ? 'drain-and-block' : 'bootstrap' },
                            { name: 'ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN', value: serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED', value: serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED', value: serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED', value: serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED', value: serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_PROVIDER_ADMISSION_ENABLED', value: serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_BETA_PREPARE_ENABLED', value: 'false' },
                            { name: 'PREFLIGHT_TASKS_ENABLED', value: role === 'preflight' && serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_V2_TASKS_ENABLED', value: role === 'paid' && serviceActive ? 'true' : 'false' },
                            { name: 'ANALYSIS_V2_WORKER_ENABLED', value: role === 'paid' && serviceActive ? 'true' : 'false' },
                            ...secretEnv,
                        ],
                    }],
                },
            },
        },
    };
    const serviceJson = deepMerge(serviceJsonDefaults, options.serviceOverrides ?? {});
    const serviceEnv = serviceJson.spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>;
    for (const [name, value] of Object.entries(options.serviceEnv ?? {})) {
        const index = serviceEnv.findIndex((entry) => entry.name === name);
        if (value === null) {
            if (index >= 0) serviceEnv.splice(index, 1);
        } else if (index < 0) {
            serviceEnv.push({ name, value });
        } else {
            serviceEnv[index].value = value;
        }
    }
    const containerSpec = serviceJson.spec.template.spec as {
        containers: Array<{ resources: { limits: { cpu: string; memory: string } } }>;
        resources?: unknown;
    };
    const container = containerSpec.containers[0];
    if (options.serviceResourceShape === 'missing') {
        Reflect.deleteProperty(container, 'resources');
    } else if (options.serviceResourceShape === 'wrong-cpu') {
        container.resources.limits.cpu = '1';
    } else if (options.serviceResourceShape === 'wrong-memory') {
        container.resources.limits.memory = '1Gi';
    } else if (options.serviceResourceShape === 'legacy-top-level-only') {
        containerSpec.resources = { limits: { cpu: '2', memory: '2Gi' } };
        Reflect.deleteProperty(container, 'resources');
    }
    if (options.omitMinScaleAnnotation) {
        Reflect.deleteProperty(serviceJson.spec.template.metadata.annotations, 'autoscaling.knative.dev/minScale');
    }
    const iamJson = options.iam ?? {
        version: 1,
        etag: 'BwXfixture01=',
        bindings: [
                { role: 'roles/viewer', members: ['serviceAccount:unrelated@example-project.iam.gserviceaccount.com'] },
            { role: 'roles/run.invoker', members: [
                `serviceAccount:${taskServiceAccount}`,
                `serviceAccount:${env[`${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL` as keyof typeof env]}`,
            ] },
        ],
    };
    const binDir = join(fixtureDir, 'bin');
    const servicePath = join(fixtureDir, 'service.json');
    const iamPath = join(fixtureDir, 'iam.json');
    const schedulerPath = join(fixtureDir, 'scheduler.json');
    const readinessPath = join(fixtureDir, 'readiness.json');
    const legacyQueuePath = join(fixtureDir, 'legacy-queue.json');
    const legacyTasksPath = join(fixtureDir, 'legacy-tasks.json');
    const publicFreezePath = join(fixtureDir, 'public-freeze.json');
    const vercelDeploymentsPath = join(fixtureDir, 'vercel-deployments.json');
    const vercelAliasesPath = join(fixtureDir, 'vercel-aliases.json');
    const vercelProjectEnvironmentPath = join(fixtureDir, 'vercel-project-environment.json');
    const queueTasksPath = join(fixtureDir, 'queue-tasks.json');
    const targetQueuePath = join(fixtureDir, 'target-queue.json');
    const lockPath = join(fixtureDir, 'deploy.lock');
    const manifestPath = join(fixtureDir, 'runtime.json');
    const logPath = join(fixtureDir, 'calls.log');
    const fakeGcloud = join(binDir, 'gcloud');
    const fakeCurl = join(binDir, 'curl');
    const fakeNode = join(binDir, 'node');
    const fixtureLauncher = join(root, 'scripts/capacity-identity-epoch/exclusion-launcher.fixture.ts');
    // This fake has no network access and mutates only fixture files when a
    // set-iam-policy command is explicitly exercised by --apply.
    writeFileSync(servicePath, JSON.stringify(serviceJson));
    if (options.serviceJsonPatch) {
        writeFileSync(servicePath, execFileSync('jq', [options.serviceJsonPatch, servicePath], {
            encoding: 'utf8',
            timeout: CHILD_PROCESS_TIMEOUT_MS,
        }));
    }
    writeFileSync(iamPath, JSON.stringify(iamJson));
    writeFileSync(legacyQueuePath, JSON.stringify({
        name: 'projects/example-project/locations/asia-northeast3/queues/analysis-pipeline',
        state: 'PAUSED',
    }));
    writeFileSync(legacyTasksPath, JSON.stringify([]));
    // An empty file makes the fake `tasks queues describe` fail, which models an
    // unobservable target queue.
    writeFileSync(
        targetQueuePath,
        options.targetQueue === 'unobservable' ? '' : JSON.stringify({
            name: `projects/${env[`${prefix}_PROJECT` as keyof typeof env]}/locations/${env[`${prefix}_LOCATION` as keyof typeof env]}/queues/${queue}`,
            state: 'PAUSED',
            ...(options.targetQueue ?? {}),
        }),
    );
    writeFileSync(publicFreezePath, JSON.stringify({
        schemaVersion: 'analysis-public-freeze-readiness-v3',
        ready: active,
        stage,
        freezeMode: active ? 'drain-and-block' : 'unknown',
        publicFreezeEnabled: active,
        sourceSha: active ? sourceCommit : null,
        legacyTargetResource: 'vercel:production:analysis-v1',
        preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        preflightProducerConfigFingerprint: active ? producerConfigFingerprint(env, 'preflight') : null,
        preflightProducerConfigReady: active,
        paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        paidProducerConfigFingerprint: active ? producerConfigFingerprint(env, 'paid') : null,
        paidProducerConfigReady: active,
        analysisV2AdmissionEnabled: active,
        earlybirdWebhookAutoAdmissionEnabled: active,
        routes: Object.fromEntries([
            '/api/analysis/start', '/api/analysis/step', '/api/analysis/run',
        ].map((route) => [route, {
            gateState: active ? 'frozen' : 'not_ready',
            expectedStatus: active ? 410 : 503,
            gateBeforeRuntime: true,
        }])),
        ...options.publicFreeze,
    }));
    writeFileSync(vercelDeploymentsPath, JSON.stringify(options.vercelDeployments ?? {
        deployments: [{
            uid: 'dpl_fixture',
            url: 'vercel-fixture.example.com',
            target: 'production',
            readyState: 'READY',
            meta: { githubCommitSha: sourceCommit },
        }],
    }));
    writeFileSync(vercelAliasesPath, JSON.stringify(options.vercelAliases ?? {
        aliases: [{ uid: 'alias_fixture', alias: 'public.example.com', created: '2026-08-01T00:00:00.000Z' }],
    }));
    const defaultVercelProjectEnvironment = options.vercelProjectEnvironment ?? {
        envs: [
            { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
            { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
            { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
            { key: 'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
            { key: 'ANALYSIS_V2_TASKS_TARGET_URL', target: ['production'] },
            { key: 'ANALYSIS_V2_TASKS_OIDC_AUDIENCE', target: ['production'] },
        ],
        hiddenProductionEnvCount: 0,
    };
    writeFileSync(vercelProjectEnvironmentPath, JSON.stringify(defaultVercelProjectEnvironment));
    const queueTaskPrefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    writeFileSync(queueTasksPath, JSON.stringify(options.queueTasks ?? [{
        name: `projects/example-project/locations/asia-northeast3/queues/${env[`${queueTaskPrefix}_QUEUE` as keyof typeof env]}/tasks/probe-fixture`,
        httpRequest: {
            url: env[`${queueTaskPrefix}_TARGET_URL` as keyof typeof env],
            oidcToken: {
                serviceAccountEmail: env[`${queueTaskPrefix}_SERVICE_ACCOUNT_EMAIL` as keyof typeof env],
                audience: env[`${queueTaskPrefix}_OIDC_AUDIENCE` as keyof typeof env],
            },
        },
    }]));
    const schedulerJobName = `projects/${env.PREFLIGHT_TASKS_PROJECT}/locations/${env.PREFLIGHT_TASKS_LOCATION}/jobs/${env.PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB}`;
    writeFileSync(schedulerPath, options.schedulerJob === 'unobservable' ? '' : JSON.stringify({
        name: schedulerJobName,
        schedule: '* * * * *',
        timeZone: 'Etc/UTC',
        httpTarget: {
            uri: `${origin}/api/analysis/preflight/recover`,
            httpMethod: 'POST',
            oidcToken: {
                serviceAccountEmail: env.PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL,
                audience: env.PREFLIGHT_TASKS_MAINTENANCE_OIDC_AUDIENCE,
            },
            headers: { 'Content-Type': 'application/json' },
            body: 'e30=',
        },
        attemptDeadline: '300s',
        retryConfig: {
            retryCount: 3,
            maxRetryDuration: '300s',
            minBackoffDuration: '10s',
            maxBackoffDuration: '60s',
            maxDoublings: 3,
        },
        state: serviceStage === 'bootstrap' ? 'PAUSED' : 'ENABLED',
        ...(typeof options.schedulerJob === 'object' ? options.schedulerJob : {}),
    }));
    writeFileSync(readinessPath, JSON.stringify(options.readiness ?? {
        ready: true,
        legacyActiveProviderRuns: 0,
        legacyActivePreflightRuns: 0,
        legacyActiveProfileRepairRuns: 0,
        legacyActiveV1ProviderRuns: 0,
        legacyActiveProcessingClaims: 0,
        legacyActiveV2JobClaims: 0,
        legacyActiveProfileProviderCanaryRuns: 0,
        legacyActiveOldTargetInvocations: 0,
        legacyActiveQueuedPreflightTasks: 0,
        legacyActiveQueuedV2Tasks: 0,
        legacyActiveFreshAdmissions: 0,
        legacyActiveBetaPrepare: 0,
        unreconciledProviderRuns: 0,
        unreconciledPreflightRuns: 0,
        unreconciledProfileRepairRuns: 0,
        unreconciledV1ProviderRuns: 0,
        unreconciledProfileProviderCanaryRuns: 0,
        legacyActiveTotal: 0,
        unreconciledTotal: 0,
    }));
    const desiredManifest = manifestFor(role, {
        ANALYSIS_CAPACITY_STAGE: stage,
        ANALYSIS_CAPACITY_EXPANSION_CANARY: expansionCanary,
        ...options.manifestOverrides,
    }, options.environment) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify(desiredManifest));
    // The real `gcloud run deploy` writes the reviewed manifest identities and
    // the `--service-account` runtime identity into the new revision.  Mirror
    // exactly those three fields so post-deploy verification stays authentic,
    // and let a test withhold exactly one of them.
    const taskIdentityKey = `${prefix}_SERVICE_ACCOUNT_EMAIL`;
    const enqueuerIdentityKey = `${prefix}_ENQUEUER_SERVICE_ACCOUNT_EMAIL`;
    const skippedIdentityKey = options.deploySkipsIdentity === 'task'
        ? taskIdentityKey
        : options.deploySkipsIdentity === 'enqueuer' ? enqueuerIdentityKey : '';
    const deployIdentityEnv = [taskIdentityKey, enqueuerIdentityKey]
        .filter((key) => typeof desiredManifest[key] === 'string' && key !== skippedIdentityKey)
        .map((key) => ({ name: key, value: desiredManifest[key] as string }));
    const postDeployDriftKey = options.postDeployIdentityDrift?.field === 'task'
        ? taskIdentityKey
        : options.postDeployIdentityDrift?.field === 'enqueuer' ? enqueuerIdentityKey
            : options.postDeployIdentityDrift?.field === 'runtime' ? '__runtime__' : '';
    const buildManifestPath = join(fixtureDir, 'build.json');
    writeFileSync(buildManifestPath, JSON.stringify({
        NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key-fixture',
    }));
    writeFileSync(logPath, '');
    mkdirSync(binDir, { recursive: true });
    const fakeScript = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GCLOUD_CALL_LOG"
if [[ "\${1:-}" == "storage" && "\${2:-}" == "cat" ]]; then
  cat "$FAKE_GCLOUD_LOCK_PATH"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "auth list" ]]; then printf '%s\\n' 'operator@example.com'; exit 0; fi
if [[ "\${1:-} \${2:-}" == "services list" ]]; then printf '%s\\n' 'cloudscheduler.googleapis.com'; exit 0; fi
if [[ "\${1:-} \${2:-} \${3:-}" == "iam service-accounts describe" ]]; then
  printf '%s\\n' '{"email":"'"$FAKE_GCLOUD_MAINTENANCE_EMAIL"'","disabled":false}'
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-}" == "secrets versions access" ]]; then
  printf '%s\\n' 'fixture-secret-marker'
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-} \${4:-}" == "iam service-accounts keys list" ]]; then exit 0; fi
if [[ "\${1:-} \${2:-}" == "projects get-iam-policy" ]]; then exit 0; fi
if [[ "\${1:-} \${2:-} \${3:-}" == "tasks queues describe" ]]; then
  if [[ "\${4:-}" == "$FAKE_GCLOUD_LEGACY_QUEUE_NAME" ]]; then
    cat "$FAKE_GCLOUD_LEGACY_QUEUE_JSON"
    exit 0
  fi
  [[ -s "$FAKE_GCLOUD_TARGET_QUEUE_JSON" ]] || exit 1
  cat "$FAKE_GCLOUD_TARGET_QUEUE_JSON"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "tasks list" ]]; then
  if [[ "$*" == *"--queue=analysis-pipeline"* ]]; then
    cat "$FAKE_GCLOUD_LEGACY_TASKS_JSON"
  else
    if [[ "$*" == *"--limit="* ]]; then
      jq '.[0:20]' "$FAKE_GCLOUD_QUEUE_TASKS_JSON"
    else
      cat "$FAKE_GCLOUD_QUEUE_TASKS_JSON"
    fi
  fi
  exit 0
fi
if [[ "\${1:-}" == "storage" && "\${2:-}" == "cp" ]]; then
  if [[ -e "$FAKE_GCLOUD_LOCK_PATH" ]]; then exit 1; fi
  cp "\$3" "$FAKE_GCLOUD_LOCK_PATH"
  printf '1' > "$FAKE_GCLOUD_LOCK_GENERATION_PATH"
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-}" == "storage objects describe" ]]; then
  [[ -e "$FAKE_GCLOUD_LOCK_PATH" ]] || exit 1
  cat "$FAKE_GCLOUD_LOCK_GENERATION_PATH"
  exit 0
fi
if [[ "\${1:-}" == "storage" && "\${2:-}" == "cat" ]]; then
  cat "$FAKE_GCLOUD_LOCK_PATH"
  exit 0
fi
if [[ "\${1:-}" == "storage" && "\${2:-}" == "rm" ]]; then
  rm -f "$FAKE_GCLOUD_LOCK_PATH" "$FAKE_GCLOUD_LOCK_GENERATION_PATH"
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-}" == "run services describe" ]]; then
  cat "$FAKE_GCLOUD_SERVICE_JSON"
  describe_count=\$(( \$(cat "$FAKE_GCLOUD_SERVICE_DESCRIBE_COUNT" 2>/dev/null || printf '0') + 1 ))
  printf '%s' "\$describe_count" > "$FAKE_GCLOUD_SERVICE_DESCRIBE_COUNT"
  if [[ -n "$FAKE_GCLOUD_SERVICE_DRIFT_AFTER" && "\$describe_count" == "$FAKE_GCLOUD_SERVICE_DRIFT_AFTER" ]]; then
    jq "$FAKE_GCLOUD_SERVICE_DRIFT_PATCH" "$FAKE_GCLOUD_SERVICE_JSON" > "$FAKE_GCLOUD_SERVICE_JSON.drift"
    mv "$FAKE_GCLOUD_SERVICE_JSON.drift" "$FAKE_GCLOUD_SERVICE_JSON"
  fi
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-}" == "run revisions describe" ]]; then
  for argument in "\$@"; do
    [[ "\$argument" != --service=* ]] || {
      printf '%s\\n' 'ERROR: --service is not supported for run revisions describe' >&2
      exit 2
    }
  done
  jq --arg revision "\${4:-}" --arg service "\$FAKE_GCLOUD_REVISION_SERVICE" \
    --arg source "\$FAKE_GCLOUD_STAGED_SOURCE_SHA" \
    '{metadata:{name:$revision,labels:{"serving.knative.dev/service":$service,"analysis-v2-source-commit":$source}},spec:.spec.template.spec,status:{conditions:[{type:"Ready",status:"True"}]}}' \
    "$FAKE_GCLOUD_SERVICE_JSON"
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-}" == "run services get-iam-policy" ]]; then
  cat "$FAKE_GCLOUD_IAM_JSON"
  iam_read_count=\$(( \$(cat "$FAKE_GCLOUD_IAM_READ_COUNT" 2>/dev/null || printf '0') + 1 ))
  printf '%s' "\$iam_read_count" > "$FAKE_GCLOUD_IAM_READ_COUNT"
  if [[ -n "$FAKE_GCLOUD_IAM_DRIFT_AFTER" && "\$iam_read_count" == "$FAKE_GCLOUD_IAM_DRIFT_AFTER" ]]; then
    jq "$FAKE_GCLOUD_IAM_DRIFT_PATCH" "$FAKE_GCLOUD_IAM_JSON" > "$FAKE_GCLOUD_IAM_JSON.drift"
    mv "$FAKE_GCLOUD_IAM_JSON.drift" "$FAKE_GCLOUD_IAM_JSON"
  fi
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "run deploy" ]]; then
  jq --arg rev "$FAKE_GCLOUD_NEXT_REVISION" --arg stage "$FAKE_GCLOUD_TARGET_STAGE" --arg active "$FAKE_GCLOUD_ACTIVE" --arg role "$FAKE_GCLOUD_ROLE" --arg source "$FAKE_GCLOUD_SOURCE_SHA" --arg stagedTraffic "$FAKE_GCLOUD_STAGED_TRAFFIC" --argjson desiredSecretEnv "$FAKE_GCLOUD_DEPLOY_SECRET_ENV" --argjson desiredIdentityEnv "$FAKE_GCLOUD_DEPLOY_IDENTITY_ENV" --arg desiredRuntimeSa "$FAKE_GCLOUD_DEPLOY_RUNTIME_SA" '
    .status.latestCreatedRevisionName = $rev
    | if $active == "false"
      then .status.latestReadyRevisionName = $rev | .status.traffic = [{revisionName:$rev,percent:100}]
      elif $stagedTraffic == "zero-percent"
      then .status.traffic += [{revisionName:$rev,percent:0}]
      elif $stagedTraffic == "real-change"
      then .status.traffic = [{revisionName:"unexpected-serving-revision",percent:100},{revisionName:$rev,percent:0}]
      else .
      end
    | .metadata.labels["analysis-v2-source-commit"] = $source
    | .spec.template.metadata.labels["analysis-v2-source-commit"] = $source
    | .metadata.labels["analysis-capacity-stage"] = $stage
    | .spec.template.metadata.labels["analysis-capacity-stage"] = $stage
    | (.spec.template.spec.containers[0].env) |= map(
        if .name == "ANALYSIS_CAPACITY_STAGE" then .value = $stage
        elif .name == "ANALYSIS_CAPACITY_EXPANSION_CANARY" then .value = (if $stage == "expanded" then "true" else "false" end)
        elif .name == "ANALYSIS_PROVIDER_ADMISSION_ENABLED" then .value = $active
        elif .name == "ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE" then .value = (if $active == "true" then "drain-and-block" else "bootstrap" end)
        elif .name == "ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN" then .value = (if $active == "true" then "true" else "false" end)
        elif .name == "ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED" then .value = (if $active == "true" then "true" else "false" end)
        elif .name == "ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED" then .value = (if $active == "true" then "true" else "false" end)
        elif .name == "ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED" then .value = (if $active == "true" then "true" else "false" end)
        elif .name == "ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED" then .value = $active
        elif .name == "PREFLIGHT_TASKS_ENABLED" then .value = (if $stage == "bootstrap" or $role != "preflight" then "false" else "true" end)
        elif .name == "ANALYSIS_V2_TASKS_ENABLED" then .value = (if $stage == "bootstrap" or $role != "paid" then "false" else "true" end)
        elif .name == "ANALYSIS_V2_WORKER_ENABLED" then .value = (if $stage == "bootstrap" or $role != "paid" then "false" else "true" end)
        elif .name == "PREFLIGHT_TASKS_RECOVERY_ENABLED" then .value = (if $stage == "bootstrap" or $role != "preflight" then "false" else "true" end)
        elif .name == "ANALYSIS_V2_RECOVERY_ENABLED" then .value = (if $stage == "bootstrap" or $role != "paid" then "false" else "true" end)
        elif .name == "PREFLIGHT_APIFY_API_TOKEN_SLOTS" then .value = "primary,tertiary,quaternary,quinary,senary,septenary,octonary,nonary,tenth"
        else . end
      )
    | (.spec.template.spec.containers[0].env) as $currentEnv
    | .spec.template.spec.containers[0].env = reduce $desiredSecretEnv[] as $desired ($currentEnv;
        if any(.[]; .name == $desired.name)
        then map(if .name == $desired.name then $desired else . end)
        else . + [$desired]
        end
      )
    | (if $desiredRuntimeSa == "" then . else .spec.template.spec.serviceAccountName = $desiredRuntimeSa end)
    | (.spec.template.spec.containers[0].env) as $identityEnv
    | .spec.template.spec.containers[0].env = reduce $desiredIdentityEnv[] as $desired ($identityEnv;
        if any(.[]; .name == $desired.name)
        then map(if .name == $desired.name then {name: .name, value: $desired.value} else . end)
        else . + [$desired]
        end
      )
  ' "$FAKE_GCLOUD_SERVICE_JSON" > "$FAKE_GCLOUD_SERVICE_JSON.tmp"
  mv "$FAKE_GCLOUD_SERVICE_JSON.tmp" "$FAKE_GCLOUD_SERVICE_JSON"
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-}" == "run services set-iam-policy" ]]; then
  cp "\${5:-}" "$FAKE_GCLOUD_LAST_SET_IAM_POLICY"
  if [[ "$FAKE_GCLOUD_FAIL_SET_IAM" == "true" ]]; then
    printf 'ERROR: simulated set-iam-policy conflict\\n' >&2
    exit 1
  fi
  # Optimistic concurrency: when the stored policy carries an etag, a write must
  # present that exact etag or the server rejects it.
  current_etag="\$(jq -r '.etag // ""' "$FAKE_GCLOUD_IAM_JSON")"
  if [[ -n "\$current_etag" ]]; then
    sent_etag="\$(jq -r '.etag // ""' "\${5:-}")"
    if [[ "\$sent_etag" != "\$current_etag" ]]; then
      printf 'ERROR: etag mismatch; policy was modified concurrently\\n' >&2
      exit 1
    fi
  fi
  # A real server issues a fresh etag on every accepted write.
  jq '.etag = "BwXfixtureNEXT="' "\${5:-}" > "$FAKE_GCLOUD_IAM_JSON"
  if [[ -n "$FAKE_GCLOUD_POST_SET_IAM_PATCH" ]]; then
    jq "$FAKE_GCLOUD_POST_SET_IAM_PATCH" "$FAKE_GCLOUD_IAM_JSON" > "$FAKE_GCLOUD_IAM_JSON.patched"
    mv "$FAKE_GCLOUD_IAM_JSON.patched" "$FAKE_GCLOUD_IAM_JSON"
  fi
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-}" == "run services update-traffic" ]]; then
  revision='';
  for argument in "\$@"; do
    case "\$argument" in --to-revisions=*) revision="\${argument#--to-revisions=}"; revision="\${revision%%=*}" ;; esac
  done
  jq --arg rev "\$revision" --arg postDeploySourceSha "\$FAKE_GCLOUD_POST_DEPLOY_SOURCE_SHA" \
    --arg driftKey "$FAKE_GCLOUD_POST_DEPLOY_DRIFT_KEY" --arg driftValue "$FAKE_GCLOUD_POST_DEPLOY_DRIFT_VALUE" '
    .status.traffic=[{revisionName:$rev,percent:100}]
    | .status.latestReadyRevisionName=$rev
    | (if $driftKey == "" then .
       elif $driftKey == "__runtime__" then .spec.template.spec.serviceAccountName = $driftValue
       else
        (.spec.template.spec.containers[0].env) |= map(
          if .name == $driftKey then {name: .name, value: $driftValue} else . end)
      end)
    | if $postDeploySourceSha == "" then . else
        .metadata.labels["analysis-v2-source-commit"]=$postDeploySourceSha
        | .spec.template.metadata.labels["analysis-v2-source-commit"]=$postDeploySourceSha
      end
  ' "$FAKE_GCLOUD_SERVICE_JSON" > "$FAKE_GCLOUD_SERVICE_JSON.tmp"
  mv "$FAKE_GCLOUD_SERVICE_JSON.tmp" "$FAKE_GCLOUD_SERVICE_JSON"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "scheduler jobs" && "\${3:-}" == "describe" ]]; then
  [[ -s "$FAKE_GCLOUD_SCHEDULER_JSON" ]] || exit 1
  cat "$FAKE_GCLOUD_SCHEDULER_JSON"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "scheduler jobs" && ("\${3:-}" == "create" || "\${3:-}" == "update") ]]; then
  jq -n --arg uri "$FAKE_GCLOUD_SCHEDULER_URI" --arg email "$FAKE_GCLOUD_MAINTENANCE_EMAIL" --arg audience "$FAKE_GCLOUD_MAINTENANCE_AUDIENCE" '{schedule:"* * * * *",timeZone:"Etc/UTC",httpTarget:{uri:$uri,httpMethod:"POST",oidcToken:{serviceAccountEmail:$email,audience:$audience},headers:{"Content-Type":"application/json"},body:"e30="},attemptDeadline:"300s",retryConfig:{retryCount:3,maxRetryDuration:"300s",minBackoffDuration:"10s",maxBackoffDuration:"60s",maxDoublings:3},state:"ENABLED"}' > "$FAKE_GCLOUD_SCHEDULER_JSON"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "scheduler jobs" && ("\${3:-}" == "pause" || "\${3:-}" == "resume") ]]; then
  state='ENABLED'; [[ "\${3:-}" == "pause" ]] && state='PAUSED'; jq --arg state "\$state" '.state=\$state' "$FAKE_GCLOUD_SCHEDULER_JSON" > "$FAKE_GCLOUD_SCHEDULER_JSON.tmp"; mv "$FAKE_GCLOUD_SCHEDULER_JSON.tmp" "$FAKE_GCLOUD_SCHEDULER_JSON"; exit 0
fi
printf 'UNHANDLED_FAKE_GCLOUD_INVOCATION %s\n' "$*" >&2
exit 91
`;
    writeFileSync(fakeGcloud, fakeScript);
    writeFileSync(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >> "$FAKE_GCLOUD_CALL_LOG"
url=''
previous=''
output_path=''
request_method='GET'
consume_stdin=false
for argument in "$@"; do
  if [[ "$previous" == '--url' ]]; then url="$argument"; fi
  if [[ "$previous" == '--output' || "$previous" == '-o' ]]; then output_path="$argument"; fi
  if [[ "$previous" == '--request' || "$previous" == '-X' ]]; then request_method="$argument"; fi
  if [[ "$previous" == '--header' && "$argument" == '@-' ]] \
    || [[ "$previous" == '--config' && "$argument" == '-' ]]; then
    consume_stdin=true
  fi
  previous="$argument"
done
# Real curl consumes stdin for --header @- (and --config -).  Always drain the
# requested stream before emitting a response so the producer side of a pipe
# cannot receive a timing-dependent SIGPIPE when a fake response is terminal.
if [[ "$consume_stdin" == true ]]; then
  cat >/dev/null
fi
if [[ "$url" == https://api.github.com/* ]]; then
  output_path=''
  previous=''
  for argument in "$@"; do
    if [[ "$previous" == '--output' ]]; then output_path="$argument"; fi
    previous="$argument"
  done
  if [[ -n "$output_path" ]]; then
    cp "$FAKE_GITHUB_JSON" "$output_path"
    printf '200'
  else
    cat "$FAKE_GITHUB_JSON"
  fi
  exit 0
fi
if [[ "$url" == https://api.vercel.test/v6/deployments* ]]; then
  cat "$FAKE_VERCEL_DEPLOYMENTS_JSON"
  exit 0
fi
if [[ "$url" == https://api.vercel.test/v10/projects/*/env* ]]; then
  cat "$FAKE_VERCEL_PROJECT_ENV_JSON"
  exit 0
fi
if [[ "$url" == https://api.vercel.test/v2/deployments/*/aliases* ]]; then
  cat "$FAKE_VERCEL_ALIASES_JSON"
  exit 0
fi
if [[ "$url" == */api/analysis/capacity/readiness ]]; then
  cat "$FAKE_GCLOUD_PUBLIC_FREEZE_JSON"
elif [[ "$request_method" == 'POST' && "$url" =~ /api/analysis/(start|step|run)$ ]]; then
  for arg in "$@"; do
    [[ "$arg" != *Authorization* ]] || exit 101
  done
  if [[ -n "$output_path" ]]; then
    printf '{"error":"Legacy analysis intake is unavailable.","code":"LEGACY_ANALYSIS_FROZEN"}\n' >"$output_path"
    printf '410'
  else
    printf '{"error":"Legacy analysis intake is unavailable.","code":"LEGACY_ANALYSIS_FROZEN"}\n410\n'
  fi
else
  cat "$FAKE_GCLOUD_READINESS_JSON"
fi
`);
    // Ordinary exclusion launches are still exercised as real shell
    // subprocesses, but the supervisor dependency is injected through this
    // test-only executable wrapper.  Production `node` and the production
    // launcher always retain the authenticated GCS supervisor default.
    writeFileSync(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${3:-}" == */exclusion-launcher.ts ]]; then
  exec "$FAKE_NODE_REAL" --import tsx "$FAKE_NODE_FIXTURE_LAUNCHER" "\${@:4}"
fi
exec "$FAKE_NODE_REAL" "$@"
`);
    chmodSync(fakeGcloud, 0o755);
    chmodSync(fakeCurl, 0o755);
    chmodSync(fakeNode, 0o755);
    try {
        const result = spawnSync('bash', [
            'scripts/deploy-analysis-capacity-workers.sh',
            `--role=${role}`,
            ...(options.args ?? ['--check']),
        ], {
            cwd: root,
            env: {
                ...process.env,
                ...env,
                PATH: `${binDir}:${process.env.PATH ?? ''}`,
                ANALYSIS_CAPACITY_SOURCE_DIR: sourceDir,
                ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: stage === 'bootstrap' ? 'false' : 'true',
                ANALYSIS_CAPACITY_ENV_VARS_FILE: manifestPath,
                ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE: buildManifestPath,
                ANALYSIS_CAPACITY_STAGE: stage,
                ANALYSIS_CAPACITY_EXPANSION_CANARY: expansionCanary,
                [role === 'preflight'
                    ? 'PREFLIGHT_TASKS_RECOVERY_ENABLED'
                    : 'ANALYSIS_V2_RECOVERY_ENABLED']: active ? 'true' : 'false',
                FAKE_GCLOUD_CALL_LOG: logPath,
                FAKE_NODE_REAL: process.execPath,
                FAKE_NODE_FIXTURE_LAUNCHER: fixtureLauncher,
                FAKE_GCLOUD_SERVICE_JSON: servicePath,
                FAKE_GCLOUD_IAM_JSON: iamPath,
                FAKE_GCLOUD_SCHEDULER_JSON: schedulerPath,
                FAKE_GCLOUD_READINESS_JSON: readinessPath,
                FAKE_GCLOUD_LEGACY_QUEUE_JSON: legacyQueuePath,
                FAKE_GCLOUD_LEGACY_TASKS_JSON: legacyTasksPath,
                FAKE_GCLOUD_PUBLIC_FREEZE_JSON: publicFreezePath,
                FAKE_GCLOUD_LOCK_PATH: lockPath,
                FAKE_GCLOUD_LOCK_GENERATION_PATH: `${lockPath}.generation`,
                FAKE_GITHUB_JSON: join(fixtureDir, 'github.json'),
                FAKE_VERCEL_DEPLOYMENTS_JSON: vercelDeploymentsPath,
                FAKE_VERCEL_ALIASES_JSON: vercelAliasesPath,
                FAKE_VERCEL_PROJECT_ENV_JSON: vercelProjectEnvironmentPath,
                FAKE_GCLOUD_QUEUE_TASKS_JSON: queueTasksPath,
                FAKE_GCLOUD_TARGET_QUEUE_JSON: targetQueuePath,
                FAKE_GCLOUD_LEGACY_QUEUE_NAME: env.ANALYSIS_CAPACITY_LEGACY_QUEUE,
                FAKE_GCLOUD_SERVICE_DESCRIBE_COUNT: join(fixtureDir, 'service-describe.count'),
                FAKE_GCLOUD_IAM_READ_COUNT: join(fixtureDir, 'iam-read.count'),
                FAKE_GCLOUD_SERVICE_DRIFT_AFTER: options.serviceDriftAfterReads
                    ? String(options.serviceDriftAfterReads.afterReads) : '',
                FAKE_GCLOUD_SERVICE_DRIFT_PATCH: options.serviceDriftAfterReads?.patch ?? '.',
                FAKE_GCLOUD_IAM_DRIFT_AFTER: options.iamDriftAfterReads
                    ? String(options.iamDriftAfterReads.afterReads) : '',
                FAKE_GCLOUD_IAM_DRIFT_PATCH: options.iamDriftAfterReads?.patch ?? '.',
                FAKE_GCLOUD_POST_SET_IAM_PATCH: options.postSetIamPatch ?? '',
                FAKE_GCLOUD_LAST_SET_IAM_POLICY: join(fixtureDir, 'last-set-iam.json'),
                FAKE_GCLOUD_FAIL_SET_IAM: options.failSetIamPolicy ? 'true' : 'false',
                FAKE_GCLOUD_DEPLOY_IDENTITY_ENV: JSON.stringify(deployIdentityEnv),
                FAKE_GCLOUD_DEPLOY_RUNTIME_SA: options.deploySkipsIdentity === 'runtime' ? '' : runtime,
                FAKE_GCLOUD_POST_DEPLOY_DRIFT_KEY: postDeployDriftKey,
                FAKE_GCLOUD_POST_DEPLOY_DRIFT_VALUE: options.postDeployIdentityDrift?.value ?? '',
                FAKE_GCLOUD_NEXT_REVISION: `${service}-00002-staged`,
                FAKE_GCLOUD_TARGET_STAGE: stage,
                FAKE_GCLOUD_REVISION_SERVICE: options.revisionService ?? service,
                FAKE_GCLOUD_SOURCE_SHA: sourceCommit,
                FAKE_GCLOUD_STAGED_SOURCE_SHA: options.stagedSourceSha ?? sourceCommit,
                FAKE_GCLOUD_POST_DEPLOY_SOURCE_SHA: options.postDeploySourceSha ?? '',
                FAKE_GCLOUD_ACTIVE: active ? 'true' : 'false',
                FAKE_GCLOUD_ROLE: role,
                FAKE_GCLOUD_STAGED_TRAFFIC: options.stagedTraffic ?? 'none',
                FAKE_GCLOUD_DEPLOY_SECRET_ENV: JSON.stringify(secretEnv),
                FAKE_GCLOUD_MAINTENANCE_EMAIL: (env[`${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL` as keyof typeof env] as string),
                FAKE_GCLOUD_MAINTENANCE_AUDIENCE: (env[`${maintenancePrefix}_MAINTENANCE_OIDC_AUDIENCE` as keyof typeof env] as string),
                FAKE_GCLOUD_SCHEDULER_URI: `${origin}/api/analysis/preflight/recover`,
            },
            encoding: 'utf8',
            // spawnSync blocks Vitest's own test timeout while a shell waits on
            // a fake command. The bounded deadline sends SIGTERM to the
            // detached process group, then reapProcessTree confirms TERM/KILL
            // cleanup before fixture removal.
            timeout: CHILD_PROCESS_TIMEOUT_MS,
            killSignal: 'SIGTERM',
            // Node's SpawnSyncOptions type omits the runtime-supported
            // detached flag; retain the process-group contract explicitly.
            detached: true,
        } as Parameters<typeof spawnSync>[2]);
        childPid = result.pid;
        reapProcessTree(result.pid);
        childTreeReaped = true;
        const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
        const calls = readFileSync(logPath, 'utf8');
        if (timedOut) {
            throw new Error([
                `fake gcloud command exceeded the ${CHILD_PROCESS_TIMEOUT_MS}ms child-process deadline`,
                'last recorded calls:',
                calls || '<none>',
            ].join('\n'));
        }
        if (result.status === 91) {
            throw new Error([
                'fake gcloud dispatcher received an unhandled command',
                result.stderr?.toString() || '<no stderr>',
                'recorded calls:',
                calls || '<none>',
            ].join('\n'));
        }
        const finalIam = JSON.parse(readFileSync(iamPath, 'utf8')) as Record<string, unknown>;
        // An unobservable-scheduler fixture is intentionally empty.
        const schedulerContent = readFileSync(schedulerPath, 'utf8');
        const finalScheduler = (schedulerContent
            ? JSON.parse(schedulerContent)
            : {}) as Record<string, unknown>;
        const finalService = JSON.parse(readFileSync(servicePath, 'utf8')) as Record<string, unknown>;
        const lastSetIamPath = join(fixtureDir, 'last-set-iam.json');
        let sentIamPolicy: Record<string, unknown> | null = null;
        try {
            const sent = readFileSync(lastSetIamPath, 'utf8');
            if (sent) sentIamPolicy = JSON.parse(sent) as Record<string, unknown>;
        } catch {
            sentIamPolicy = null;
        }
        return { ...result, calls, finalIam, finalScheduler, finalService, sentIamPolicy };
    } finally {
        if (!childTreeReaped && childPid !== undefined) {
            try {
                reapProcessTree(childPid);
                childTreeReaped = true;
            } catch {
                // Do not remove a fixture while a timed-out descendant may
                // still be writing it; the bounded reap failure remains the
                // test's primary error and leaves forensic state intact.
            }
        }
        if (childTreeReaped || childPid === undefined) rmSync(fixtureDir, { recursive: true, force: true });
    }
}

describe('automatic-analysis infrastructure contracts', () => {
    it('uses the bounded fixture child deadline and reaps timed-out descendants before cleanup', () => {
        const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
        const oldTimeoutLiteral = ['timeout', '15_000'].join(': ');
        expect(source).toContain('timeout: CHILD_PROCESS_TIMEOUT_MS');
        expect(source).not.toContain(oldTimeoutLiteral);
        expect(source).toContain('reapProcessTree(result.pid)');
    });

    it('declares the canonical ten-slot Apify inventory in every deployment path', () => {
        const slots = [
            'primary',
            'secondary',
            'tertiary',
            'quaternary',
            'quinary',
            'senary',
            'septenary',
            'octonary',
            'nonary',
            'tenth',
        ] as const;
        for (const script of [
            'scripts/configure-analysis-v2-secrets.sh',
            'scripts/generate-analysis-v2-env-files.sh',
            'scripts/deploy-analysis-v2-worker.sh',
            'scripts/deploy-analysis-capacity-workers.sh',
        ]) {
            const source = readFileSync(join(root, script), 'utf8');
            for (const slot of slots) {
                expect(source, `${script} is missing ${slot}`).toContain(slot);
            }
        }
        expect(readFileSync(join(root, 'scripts/deploy-analysis-v2-worker.sh'), 'utf8'))
            .toContain('exactly all ten Apify Secret Manager refs');
        expect(readFileSync(join(root, 'scripts/deploy-analysis-capacity-workers.sh'), 'utf8'))
            .toContain('exactly ten Apify refs');
    });

    it('hard-fences paid workers to the secondary Apify slot', () => {
        const source = readFileSync(join(root, 'scripts/deploy-analysis-capacity-workers.sh'), 'utf8');
        expect(source).toContain('[[ "$selected_slot" == "secondary" ]]');
        expect(source).toContain('active paid worker must select ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary');
    });

    it('dry-runs a preflight queue without invoking gcloud', () => {
        const output = runQueue('configure-analysis-capacity-queues.sh', [
            '--role=preflight', '--dry-run',
        ]);
        expect(output).toContain('analysis-preflight');
        expect(output).toContain('analysis-preflight-worker');
        expect(output).toContain('ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES=32');
        expect(output).toContain('roles/cloudtasks.enqueuer');
    });

    it('keeps bootstrap queue bounds while role gates remain off', () => {
        const output = runQueue('configure-analysis-capacity-queues.sh', [
            '--role=preflight', '--dry-run',
        ], { ANALYSIS_CAPACITY_STAGE: 'bootstrap' });
        expect(output).toContain('ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES=32');
        expect(output).toContain('dry-run complete: no remote configuration was verified or changed');
    });

    it('dry-runs an isolated paid service from a strict external manifest', () => {
        const output = runQueue('deploy-analysis-capacity-workers.sh', [
            '--role=paid', '--dry-run',
        ], {
            ANALYSIS_WORKLOAD_ROLE: 'paid',
            ANALYSIS_CAPACITY_ROLE: 'paid',
        });
        expect(output).toContain('analysis-paid-worker');
        expect(output).toContain('--concurrency=1');
        expect(output).toContain('--max-instances=8');
        expect(output).toContain('--env-vars-file=');
        expect(output).not.toContain('--update-env-vars');
    });

    it('rejects repeated or conflicting modes and reconcile outside explicit apply', () => {
        for (const args of [
            ['--role=paid', '--dry-run', '--apply'],
            ['--role=paid', '--check', '--check'],
            ['--role=paid', '--apply', '--dry-run'],
            ['--role=paid', '--check', '--reconcile-iam'],
            ['--role=paid', '--dry-run', '--reconcile-iam'],
        ]) {
            const result = fakeRun({ args: args.slice(1) });
            expect(result.status).not.toBe(0);
            expect(result.stderr).toMatch(/choose exactly one|requires explicit --apply/);
            expect(result.calls).toBe('');
        }
    });

    it('fails closed when role services collide', () => {
        expect(() => runQueue('configure-analysis-capacity-queues.sh', [
            '--role=preflight', '--dry-run',
        ], { PREFLIGHT_TASKS_CLOUD_RUN_SERVICE: 'analysis-paid-worker' })).toThrow(
            'Cloud Run service must contain its workload role',
        );
    });

    it('proves check/apply parity with canonical URL, timeoutSeconds, and preserved IAM', () => {
        const checked = fakeRun({ args: ['--check'] });
        expect(checked.status, checked.stderr?.toString()).toBe(0);
        expect(checked.calls).toContain('run services describe');
        expect(checked.calls.match(/curl .*--request POST .*api\/analysis\/(start|step|run)/g) ?? [])
            .toHaveLength(3);

        const applied = fakeRun({ args: ['--apply', '--reconcile-iam'], iam: {
            bindings: [
                { role: 'roles/viewer', members: ['serviceAccount:unrelated@example-project.iam.gserviceaccount.com'] },
                { role: 'roles/run.invoker', members: ['allUsers', 'serviceAccount:stale@example-project.iam.gserviceaccount.com'] },
            ],
        }});
        expect(applied.status, `${applied.stderr?.toString() ?? ''}\n${applied.calls}`).toBe(0);
        expect(applied.calls).toContain('run deploy');
        expect(applied.calls).toMatch(/run revisions describe/);
        expect(applied.calls).not.toMatch(/run revisions describe .*--service=/);
        expect(applied.calls).toContain('--env-vars-file=');
        expect(applied.calls).toContain('--build-env-vars-file=');
        expect(applied.calls).toContain('--set-secrets=APIFY_SECONDARY_API_TOKEN=ai-baram-v2-apify-secondary:7');
        expect(applied.calls).not.toContain('--update-env-vars');
        expect(applied.calls.match(/curl .*--request POST .*api\/analysis\/(start|step|run)/g) ?? [])
            .toHaveLength(9);
        expect(applied.finalIam.bindings).toEqual([
            { role: 'roles/viewer', members: ['serviceAccount:unrelated@example-project.iam.gserviceaccount.com'] },
            { role: 'roles/run.invoker', members: [
                'serviceAccount:paid-maintenance@example-project.iam.gserviceaccount.com',
                'serviceAccount:paid-task@example-project.iam.gserviceaccount.com',
            ] },
        ]);
    });

    it('fails closed when the production preflight producer task identity drifts', () => {
        const result = fakeRun({
            role: 'preflight',
            queueTasks: [{
                httpRequest: {
                    url: 'https://preflight.example.com/api/analysis/preflight/worker',
                    oidcToken: {
                        serviceAccountEmail: 'other-task@example-project.iam.gserviceaccount.com',
                        audience: 'https://preflight.example.com',
                    },
                },
            }],
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'preflight queue task OIDC contract',
        );
        expect(result.calls).not.toContain('run deploy');
    });

    it.each([
        ['target', { url: 'https://other.example.com/api/analysis/preflight/worker', audience: 'https://preflight.example.com' }],
        ['audience', { url: 'https://preflight.example.com/api/analysis/preflight/worker', audience: 'https://other.example.com' }],
    ] as const)('fails closed when an observed preflight task has a drifted %s', (_name, observed) => {
        const result = fakeRun({
            role: 'preflight',
            queueTasks: [{
                httpRequest: {
                    url: observed.url,
                    oidcToken: {
                        serviceAccountEmail: 'preflight-task@example-project.iam.gserviceaccount.com',
                        audience: observed.audience,
                    },
                },
            }],
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'preflight queue task OIDC contract',
        );
        expect(result.calls).not.toContain('run deploy');
    });

    it('validates every queued preflight task after the first twenty', () => {
        const expectedTarget = baseEnvironment('preflight').PREFLIGHT_TASKS_TARGET_URL;
        const expectedAudience = baseEnvironment('preflight').PREFLIGHT_TASKS_OIDC_AUDIENCE;
        const expectedServiceAccount = baseEnvironment('preflight').PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL;
        const queueTasks = Array.from({ length: 21 }, (_, index) => ({
            name: `projects/example-project/locations/asia-northeast3/queues/analysis-preflight/tasks/task-${index + 1}`,
            httpRequest: {
                url: expectedTarget,
                oidcToken: {
                    serviceAccountEmail: expectedServiceAccount,
                    audience: expectedAudience,
                },
            },
        }));
        queueTasks[20].httpRequest.oidcToken.serviceAccountEmail = 'drifted-task@example-project.iam.gserviceaccount.com';
        const result = fakeRun({ role: 'preflight', queueTasks, args: ['--check'] });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'preflight queue task OIDC contract',
        );
        expect(result.calls).not.toMatch(/tasks list .*--limit=20/);
        expect(result.calls).not.toContain('run deploy');
    });

    it('accepts a complete Vercel v10 environment response with more than one hundred entries', () => {
        const filler = Array.from({ length: 101 }, (_, index) => ({
            key: `UNRELATED_ENV_${index}`,
            target: ['production'],
        }));
        const result = fakeRun({
            role: 'preflight',
            queueTasks: [],
            vercelProjectEnvironment: {
                envs: [
                    ...filler,
                    { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 0,
            },
            args: ['--check'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        const envCalls = result.calls.split('\n').filter((call) => call.includes('/v10/projects/fixture-project/env'));
        expect(envCalls).toHaveLength(1);
        expect(envCalls[0]).not.toContain('limit=');
        expect(envCalls[0]).not.toContain('until=');
        expect(result.stdout).toContain('next-deploy Vercel preflight environment has required production keys');
    });

    it('fails closed when Vercel reports hidden production environment values', () => {
        const result = fakeRun({
            role: 'preflight',
            queueTasks: [],
            vercelProjectEnvironment: {
                envs: [
                    { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 1,
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'next-deploy Vercel preflight environment has hidden production values',
        );
        expect(result.calls).not.toContain('run deploy');
    });

    it.each([
        ['missing hidden count', {
            envs: [
                { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
                { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
            ],
        }],
        ['non-integer hidden count', {
            envs: [],
            hiddenProductionEnvCount: 0.5,
        }],
        ['negative hidden count', {
            envs: [],
            hiddenProductionEnvCount: -1,
        }],
        ['string hidden count', {
            envs: [],
            hiddenProductionEnvCount: '0',
        }],
        ['malformed envs', {
            envs: {},
            hiddenProductionEnvCount: 0,
        }],
    ] as const)('fails closed when the Vercel v10 response is %s', (_name, response) => {
        const result = fakeRun({ role: 'preflight', queueTasks: [], vercelProjectEnvironment: response, args: ['--check'] });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'next-deploy Vercel preflight environment response is malformed',
        );
        expect(result.calls).not.toContain('run deploy');
    });

    it('fails closed on an unexpected paginated or direct-single-env response variant', () => {
        for (const response of [
            {
                envs: [
                    { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 0,
                pagination: { next: null },
            },
            {
                env: { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                hiddenProductionEnvCount: 0,
            },
        ]) {
            const result = fakeRun({ role: 'preflight', queueTasks: [], vercelProjectEnvironment: response, args: ['--check'] });
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(
                'next-deploy Vercel preflight environment response is malformed',
            );
            expect(result.calls).not.toContain('run deploy');
        }
    });

    it('fails closed when a required Vercel environment key is duplicated', () => {
        const result = fakeRun({
            role: 'preflight',
            queueTasks: [],
            vercelProjectEnvironment: {
                envs: [
                    { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 0,
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('next-deploy Vercel preflight environment');
        expect(result.calls).not.toContain('run deploy');
    });

    it('uses the active Vercel runtime fingerprint when the preflight queue is empty', () => {
        const result = fakeRun({
            role: 'preflight',
            queueTasks: [],
            args: ['--check'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.stdout).toContain('active Vercel preflight producer fingerprint');
    });

    it('fails closed when the active Vercel runtime fingerprint drifts', () => {
        const result = fakeRun({
            role: 'preflight',
            publicFreeze: {
                preflightProducerConfigFingerprint: 'f'.repeat(64),
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'active Vercel preflight producer fingerprint',
        );
        expect(result.calls).not.toContain('run deploy');
    });

    it('fails closed when the active Vercel runtime fingerprint is missing', () => {
        const result = fakeRun({
            role: 'preflight',
            publicFreeze: {
                ready: false,
                preflightProducerConfigFingerprint: null,
                preflightProducerConfigReady: false,
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toContain('run deploy');
    });

    it('does not accept a complete manifest or project env listing without active runtime evidence', () => {
        const result = fakeRun({
            role: 'preflight',
            publicFreeze: {
                preflightProducerConfigFingerprint: 'f'.repeat(64),
            },
            vercelProjectEnvironment: {
                envs: [
                    { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 0,
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toContain('run deploy');
    });

    it('fails closed when next-deploy Vercel preflight keys are incomplete', () => {
        const result = fakeRun({
            role: 'preflight',
            vercelProjectEnvironment: {
                envs: [
                    { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 0,
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'next-deploy Vercel preflight environment',
        );
        expect(result.calls).not.toContain('run deploy');
    });

    it('uses the active Vercel paid runtime fingerprint when the paid queue is empty', () => {
        const result = fakeRun({
            role: 'paid',
            queueTasks: [],
            args: ['--check'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.stdout).toContain('active Vercel paid producer fingerprint');
    });

    it('fails closed when the active Vercel paid runtime fingerprint drifts', () => {
        const result = fakeRun({
            role: 'paid',
            queueTasks: [],
            publicFreeze: {
                paidProducerConfigFingerprint: 'f'.repeat(64),
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'active Vercel paid producer fingerprint',
        );
        expect(result.calls).not.toContain('run deploy');
    });

    it('fails closed when the active Vercel paid runtime fingerprint is missing or false', () => {
        const result = fakeRun({
            role: 'paid',
            queueTasks: [],
            publicFreeze: {
                paidProducerConfigFingerprint: null,
                paidProducerConfigReady: false,
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toContain('run deploy');
    });

    it('fails closed when next-deploy Vercel paid keys are incomplete', () => {
        const result = fakeRun({
            role: 'paid',
            queueTasks: [],
            vercelProjectEnvironment: {
                envs: [
                    { key: 'ANALYSIS_V2_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'ANALYSIS_V2_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 0,
            },
            iam: {
                bindings: [{
                    role: 'roles/run.invoker',
                    members: ['allUsers'],
                }],
            },
            args: ['--apply', '--reconcile-iam'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'next-deploy Vercel paid environment',
        );
        expect(result.calls).not.toContain('run deploy');
        expect(result.calls).not.toContain('run services set-iam-policy');
    });

    it('rejects duplicate paid next-deploy production environment metadata before IAM mutation', () => {
        const result = fakeRun({
            role: 'paid',
            queueTasks: [],
            vercelProjectEnvironment: {
                envs: [
                    { key: 'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                    { key: 'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                    { key: 'ANALYSIS_V2_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'ANALYSIS_V2_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 0,
            },
            iam: {
                bindings: [{
                    role: 'roles/run.invoker',
                    members: ['allUsers'],
                }],
            },
            args: ['--apply', '--reconcile-iam'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'next-deploy Vercel paid environment',
        );
        expect(result.calls).not.toContain('run deploy');
        expect(result.calls).not.toContain('run services set-iam-policy');
    });

    it.each([
        ['target userinfo', { ANALYSIS_V2_TASKS_TARGET_URL: 'https://user:secret@paid.example.com/api/analysis/v2/worker' }],
        ['target query', { ANALYSIS_V2_TASKS_TARGET_URL: 'https://paid.example.com/api/analysis/v2/worker?probe=1' }],
        ['target hash', { ANALYSIS_V2_TASKS_TARGET_URL: 'https://paid.example.com/api/analysis/v2/worker#probe' }],
        ['target wrong path', { ANALYSIS_V2_TASKS_TARGET_URL: 'https://paid.example.com/api/analysis/not-worker' }],
        ['audience query', { ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://paid.example.com?probe=1' }],
        ['audience hash', { ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://paid.example.com#probe' }],
        ['audience path', { ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://paid.example.com/audience' }],
        ['audience origin', { ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://other.example.com' }],
    ] as const)('rejects paid producer %s before IAM or Cloud Run mutation', (_name, environment) => {
        const result = fakeRun({
            role: 'paid',
            environment,
            iam: {
                bindings: [{
                    role: 'roles/run.invoker',
                    members: ['allUsers'],
                }],
            },
            args: ['--apply', '--reconcile-iam'],
        });
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toContain('run deploy');
        expect(result.calls).not.toContain('run services set-iam-policy');
        expect(`${result.stdout}\n${result.stderr}`).not.toContain('secret');
    });

    it.each([
        ['preflight aggregate readiness false', 'preflight', { ready: false }],
        ['preflight missing paid fingerprint', 'preflight', { paidProducerConfigFingerprint: undefined }],
        ['paid aggregate readiness false', 'paid', { ready: false }],
        ['paid missing preflight fingerprint', 'paid', { preflightProducerConfigFingerprint: undefined }],
    ] as const)('rejects %s before IAM or Cloud Run mutation', (_name, role, publicFreeze) => {
        const result = fakeRun({
            role,
            publicFreeze,
            iam: {
                bindings: [{
                    role: 'roles/run.invoker',
                    members: ['allUsers'],
                }],
            },
            args: ['--apply', '--reconcile-iam'],
        });
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toContain('run deploy');
        expect(result.calls).not.toContain('run services set-iam-policy');
    });

    it.each([
        ['task identity', {
            serviceAccountEmail: 'other-task@example-project.iam.gserviceaccount.com',
            url: 'https://paid.example.com/api/analysis/v2/worker',
            audience: 'https://paid.example.com',
        }],
        ['target', {
            serviceAccountEmail: 'paid-task@example-project.iam.gserviceaccount.com',
            url: 'https://other.example.com/api/analysis/v2/worker',
            audience: 'https://paid.example.com',
        }],
        ['audience', {
            serviceAccountEmail: 'paid-task@example-project.iam.gserviceaccount.com',
            url: 'https://paid.example.com/api/analysis/v2/worker',
            audience: 'https://other.example.com',
        }],
    ] as const)('fails closed when an observed paid task has drifted %s', (_name, observed) => {
        const result = fakeRun({
            role: 'paid',
            queueTasks: [{
                httpRequest: {
                    url: observed.url,
                    oidcToken: {
                        serviceAccountEmail: observed.serviceAccountEmail,
                        audience: observed.audience,
                    },
                },
            }],
            args: ['--apply', '--reconcile-iam'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'paid queue task OIDC contract',
        );
        expect(result.calls).not.toContain('run deploy');
        expect(result.calls).not.toContain('run services set-iam-policy');
    });

    it('verifies paid producer evidence before any IAM reconcile or Cloud Run deploy mutation', () => {
        const result = fakeRun({
            role: 'paid',
            publicFreeze: {
                paidProducerConfigFingerprint: 'f'.repeat(64),
            },
            iam: {
                bindings: [{
                    role: 'roles/run.invoker',
                    members: ['allUsers'],
                }],
            },
            args: ['--apply', '--reconcile-iam'],
        });
        expect(result.status).not.toBe(0);
        expect(result.calls).not.toContain('run deploy');
        expect(result.calls).not.toContain('run services set-iam-policy');
    });

    it('normalizes the role runtime identity manifest key against the Cloud Run service spec', () => {
        const result = fakeRun({
            role: 'preflight',
            manifestOverrides: {
                PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL: 'preflight-runtime@example-project.iam.gserviceaccount.com',
            },
            args: ['--check'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
    });

    it('rejects a runtime identity manifest alias that crosses workload roles', () => {
        const result = fakeRun({
            role: 'preflight',
            manifestOverrides: {
                PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL: 'paid-runtime@example-project.iam.gserviceaccount.com',
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL',
        );
        expect(result.calls).not.toContain('run deploy');
    });

    it('ignores a zero-percent staged revision when comparing live traffic', () => {
        const result = fakeRun({ stagedTraffic: 'zero-percent', args: ['--apply'] });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.calls).toContain('run services update-traffic');
    });

    it('fails closed when staged verification changes nonzero live traffic', () => {
        const result = fakeRun({ stagedTraffic: 'real-change', args: ['--apply'] });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
            'Cloud Run traffic changed while the staged revision was being verified',
        );
        expect(result.calls).not.toContain('run services update-traffic');
    });

    it('rejects a staged revision that belongs to a different Cloud Run service', () => {
        const result = fakeRun({
            revisionService: 'analysis-other-worker',
            args: ['--apply'],
        });
        expect(result.status).not.toBe(0);
        expect(result.stdout + '\n' + result.stderr).toContain(
            'exact Ready revision for this service',
        );
        expect(result.calls).not.toContain('run services update-traffic');
    });

    it.each([
        ['malformed aliases', { vercelAliases: { aliases: [{ uid: 'alias_fixture', alias: 42, created: '2026-08-01T00:00:00.000Z' }] } }],
        ['other deployment alias', { vercelAliases: { aliases: [{ uid: 'alias_other', alias: 'public.example.com', deploymentId: 'dpl_other', created: '2026-08-01T00:00:00.000Z' }] } }],
        ['missing public alias', { vercelAliases: { aliases: [{ uid: 'alias_other', alias: 'unrelated.example.com', created: '2026-08-01T00:00:00.000Z' }] } }],
    ] as const)('rejects Vercel alias evidence drift: %s', (_name, options) => {
        const result = fakeRun({ ...options, args: ['--check'] });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/Vercel deployment|public freeze origin/);
        expect(result.calls).not.toContain('run deploy');
    });

    it('does not trust optional aliases in the v6 deployment record', () => {
        const result = fakeRun({
            vercelDeployments: {
                deployments: [{
                    uid: 'dpl_fixture',
                    url: 'vercel-fixture.example.com',
                    aliases: ['public.example.com'],
                    target: 'production',
                    readyState: 'READY',
                    meta: { githubCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: CHILD_PROCESS_TIMEOUT_MS }).trim() },
                }],
            },
            vercelAliases: { aliases: [] },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('public freeze origin');
    });

    it.each(['preflight', 'paid'] as const)('checks the role-specific identity branch: %s', (role) => {
        const result = fakeRun({ role, args: ['--check'] });
        expect(result.status, result.stderr?.toString()).toBe(0);
        expect(result.calls).toContain('run services describe');
    });

    it('checks the preflight maintenance scheduler against the worker origin plus recovery path', () => {
        const result = fakeRun({ role: 'preflight', args: ['--check'] });
        expect(result.status).toBe(0);
        expect(result.calls).toContain('scheduler jobs describe');
        expect((result.finalScheduler.httpTarget as { uri?: string }).uri)
            .toBe('https://preflight.example.com/api/analysis/preflight/recover');
    });

    it('accepts Cloud Run default minScale when the annotation is absent', () => {
        const result = fakeRun({ omitMinScaleAnnotation: true, args: ['--check'] });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
    });

    it('rejects an invalid minScale annotation', () => {
        const result = fakeRun({
            serviceOverrides: {
                spec: {
                    template: {
                        metadata: {
                            annotations: { 'autoscaling.knative.dev/minScale': 'not-a-number' },
                        },
                    },
                },
            },
            args: ['--check'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('minScale');
        expect(result.calls).not.toContain('run deploy');
    });

    it('accepts exact container-scoped CPU and memory resources', () => {
        const result = fakeRun({ args: ['--check'] });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
    });

    it.each([
        ['missing container resources', 'missing', 'CPU contract'],
        ['wrong container CPU', 'wrong-cpu', 'CPU contract'],
        ['wrong container memory', 'wrong-memory', 'memory contract'],
        ['legacy top-level-only resources', 'legacy-top-level-only', 'CPU contract'],
    ] as const)('rejects non-contract Cloud Run resource shape: %s', (_name, serviceResourceShape, expected) => {
        const result = fakeRun({ serviceResourceShape, args: ['--check'] });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
        expect(result.calls).not.toContain('run deploy');
    });

    it.each([
        ['canonical URL', { serviceOverrides: { status: { url: 'https://wrong.example.com' } } }, 'canonical service URL'],
        ['traffic revision', { serviceOverrides: { status: { traffic: [{ revisionName: 'old-revision', percent: 100 }] } } }, 'latest ready revision'],
        ['OIDC audience', { serviceOverrides: { spec: { template: { spec: { containers: [{ env: [{ name: 'ANALYSIS_V2_TASKS_OIDC_AUDIENCE', value: 'https://wrong.example.com' }] }] } } } } }, 'OIDC audience'],
        ['stage env', { serviceOverrides: { spec: { template: { spec: { containers: [{ env: [{ name: 'ANALYSIS_WORKLOAD_ROLE', value: 'paid' }, { name: 'ANALYSIS_CAPACITY_STAGE', value: 'expanded' }] }] } } } } }, 'capacity stage'],
        ['expansion canary', { manifestOverrides: { ANALYSIS_CAPACITY_EXPANSION_CANARY: 'true' } }, 'required ANALYSIS_CAPACITY_EXPANSION_CANARY'],
        ['timeout', { serviceOverrides: { spec: { template: { spec: { timeoutSeconds: 599 } } } } }, 'timeout'],
        ['min scale', { serviceOverrides: { spec: { template: { metadata: { annotations: { 'autoscaling.knative.dev/minScale': '1' } } } } } }, 'minScale'],
        ['max scale', { serviceOverrides: { spec: { template: { metadata: { annotations: { 'autoscaling.knative.dev/maxScale': '16' } } } } } }, 'maxScale'],
        ['concurrency', { serviceOverrides: { spec: { template: { spec: { containerConcurrency: 2 } } } } }, 'containerConcurrency'],
        ['public invoker', { iam: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] } }, 'invoker IAM'],
        ['additional invoker', { iam: { bindings: [{ role: 'roles/run.invoker', members: ['serviceAccount:paid-task@example-project.iam.gserviceaccount.com', 'serviceAccount:other@example-project.iam.gserviceaccount.com'] }] } }, 'invoker IAM'],
    ] as const)('rejects observed drift: %s', (_name, options, expected) => {
        const result = fakeRun({ ...options, args: ['--check'] });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
        expect(result.calls).not.toContain('run deploy');
    });

    it('allows bootstrap only with all workload gates disabled and keeps the full private contract', () => {
        const result = fakeRun({ role: 'paid', stage: 'bootstrap', args: ['--check'] });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('verified: paid worker');
    });

    it.each(['preflight', 'paid'] as const)('allows only the explicit serving bootstrap to initial transition: %s', (role) => {
        const args = ['--apply', '--allow-bootstrap-initial-transition'];
        if (role === 'preflight') args.push('--reconcile-jobs');
        const result = fakeRun({ role, stage: 'initial', serviceStage: 'bootstrap', args });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.calls).toContain('run deploy');
        expect(result.calls).toContain('run services update-traffic');
        const deployIndex = result.calls.indexOf('run deploy');
        expect(result.calls.indexOf('tasks queues describe')).toBeGreaterThanOrEqual(0);
        expect(result.calls.indexOf('tasks queues describe')).toBeLessThan(deployIndex);
        expect(result.calls.indexOf('api/analysis/capacity/readiness')).toBeLessThan(deployIndex);
        expect(result.stdout).toContain(`verified: ${role} worker`);
    });

    it.each([
        ['wrong legacy freeze value', { serviceEnv: { ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'unexpected' } }, 'ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE'],
        ['wrong provider admission value', { serviceEnv: { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' } }, 'bootstrap admission gate'],
        ['stable routing drift', { serviceEnv: { PREFLIGHT_TASKS_TARGET_URL: 'https://wrong.example.com/api/analysis/preflight/worker' } }, 'target URL drifted'],
        ['non-serving bootstrap service', { serviceOverrides: { status: { traffic: [{ revisionName: 'bootstrap-revision', percent: 0 }] } } }, 'non-empty exact traffic allocation'],
        ['extra manifest key drift', {
            manifestOverrides: { ANALYSIS_V2_LEGACY_GATE: 'false' },
            serviceEnv: { ANALYSIS_V2_LEGACY_GATE: 'true' },
        }, 'ANALYSIS_V2_LEGACY_GATE'],
    ] as const)('rejects unsafe bootstrap to initial transition input: %s', (_name, options, expected) => {
        const result = fakeRun({
            role: 'preflight',
            stage: 'initial',
            serviceStage: 'bootstrap',
            ...options,
            args: ['--apply', '--allow-bootstrap-initial-transition', '--reconcile-jobs'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
        expect(result.calls).not.toContain('run deploy');
    });

    it.each([
        ['check mode', ['--check', '--allow-bootstrap-initial-transition']],
        ['dry-run mode', ['--dry-run', '--allow-bootstrap-initial-transition']],
    ] as const)('rejects bootstrap to initial transition flag outside apply: %s', (_name, args) => {
        const result = fakeRun({
            role: 'preflight',
            stage: 'initial',
            serviceStage: 'bootstrap',
            args: [...args],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('requires explicit --apply');
        expect(result.calls).toBe('');
    });

    it.each([
        ['initial serving service', { serviceStage: 'initial' as const }, 'observed bootstrap'],
        ['expanded target stage', { stage: 'expanded' as const, serviceStage: 'bootstrap' as const }, 'target stage=initial'],
    ] as const)('rejects bootstrap to initial transition flag outside its exact stage contract: %s', (_name, options, expected) => {
        const result = fakeRun({
            role: 'preflight',
            ...options,
            args: ['--apply', '--allow-bootstrap-initial-transition', '--reconcile-jobs'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
        expect(result.calls).not.toContain('run deploy');
    });

    it('reconciles exactly the stale preflight bootstrap cross-role gates during apply', () => {
        const result = fakeRun({
            role: 'preflight',
            stage: 'bootstrap',
            serviceEnv: {
                ANALYSIS_V2_WORKER_ENABLED: 'true',
                ANALYSIS_V2_RECOVERY_ENABLED: 'true',
            },
            args: ['--apply'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.calls).toContain('run deploy');
        expect((result.finalService.spec as { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } })
            .template.spec.containers[0].env
            .filter(({ name }) => ['ANALYSIS_V2_WORKER_ENABLED', 'ANALYSIS_V2_RECOVERY_ENABLED'].includes(name))
            .map(({ value }) => value))
            .toEqual(['false', 'false']);
    });

    it.each([
        ['check mode', { args: ['--check'] }, 'ANALYSIS_V2_RECOVERY_ENABLED'],
        ['non-bootstrap apply', { stage: 'initial' as const }, 'ANALYSIS_V2_RECOVERY_ENABLED'],
        ['paid role', { role: 'paid' as const }, 'recovery gate drifted'],
        ['own-role gate', { serviceEnv: { PREFLIGHT_TASKS_ENABLED: 'true' } }, 'bootstrap role gate'],
        ['provider admission gate', { serviceEnv: { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' } }, 'bootstrap admission gate'],
        ['missing worker key', { serviceEnv: { ANALYSIS_V2_WORKER_ENABLED: null } }, 'ANALYSIS_V2_WORKER_ENABLED'],
        ['missing recovery key', { serviceEnv: { ANALYSIS_V2_RECOVERY_ENABLED: null } }, 'ANALYSIS_V2_RECOVERY_ENABLED'],
        ['non-literal worker value', { serviceEnv: { ANALYSIS_V2_WORKER_ENABLED: 'TRUE' } }, 'ANALYSIS_V2_WORKER_ENABLED'],
        ['non-literal recovery value', { serviceEnv: { ANALYSIS_V2_RECOVERY_ENABLED: '1' } }, 'ANALYSIS_V2_RECOVERY_ENABLED'],
        ['arbitrary key', {
            manifestOverrides: { ANALYSIS_V2_LEGACY_GATE: 'false' },
            serviceEnv: { ANALYSIS_V2_LEGACY_GATE: 'true' },
        }, 'ANALYSIS_V2_LEGACY_GATE'],
        ['manifest keeps worker gate enabled', {
            manifestOverrides: { ANALYSIS_V2_WORKER_ENABLED: 'true' },
        }, 'required ANALYSIS_V2_WORKER_ENABLED'],
        ['manifest omits worker gate', {
            manifestOverrides: { ANALYSIS_V2_WORKER_ENABLED: undefined },
        }, 'required ANALYSIS_V2_WORKER_ENABLED'],
        ['manifest enables recovery gate', {
            manifestOverrides: { ANALYSIS_V2_RECOVERY_ENABLED: 'true' },
        }, 'required ANALYSIS_V2_RECOVERY_ENABLED'],
        ['manifest enables worker from a disabled service', {
            manifestOverrides: { ANALYSIS_V2_WORKER_ENABLED: 'true' },
            serviceEnv: { ANALYSIS_V2_WORKER_ENABLED: 'false' },
        }, 'required ANALYSIS_V2_WORKER_ENABLED'],
    ] as const)('fails closed for an unsafe bootstrap exception input: %s', (_name, overrides, expected) => {
        const staleCrossRoleGates = {
            ANALYSIS_V2_WORKER_ENABLED: 'true',
            ANALYSIS_V2_RECOVERY_ENABLED: 'true',
        };
        const overrideServiceEnv = 'serviceEnv' in overrides ? overrides.serviceEnv : undefined;
        const overrideArgs = 'args' in overrides ? overrides.args : undefined;
        const result = fakeRun({
            role: 'preflight',
            stage: 'bootstrap',
            ...overrides,
            serviceEnv: { ...staleCrossRoleGates, ...overrideServiceEnv },
            args: overrideArgs ? [...overrideArgs] : ['--apply'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
        expect(result.calls).not.toContain('run deploy');
    });

    it('updates an existing private gate-off bootstrap service from stale provenance', () => {
        const staleSha = 'd'.repeat(40);
        const result = fakeRun({
            role: 'preflight',
            stage: 'bootstrap',
            serviceOverrides: {
                metadata: { labels: { 'analysis-v2-source-commit': staleSha } },
            },
            args: ['--apply'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.calls).toContain('run deploy');
        expect(result.calls).not.toContain('run services update-traffic');
        expect(result.stdout).toContain('verified: preflight worker');
        expect(result.stdout).not.toContain(staleSha);
    });

    it('keeps stale bootstrap provenance fail-closed when a workload gate is unsafe', () => {
        const result = fakeRun({
            role: 'preflight',
            stage: 'bootstrap',
            serviceOverrides: {
                metadata: { labels: { 'analysis-v2-source-commit': 'd'.repeat(40) } },
                spec: {
                    template: {
                        spec: {
                            containers: [{ env: [{ name: 'PREFLIGHT_TASKS_ENABLED', value: 'true' }] }],
                        },
                    },
                },
            },
            args: ['--apply'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('bootstrap role gate');
        expect(result.calls).not.toContain('run deploy');
    });

    it('allows an existing initial service to roll forward from a valid old source SHA during apply predeploy', () => {
        const oldSourceSha = 'd'.repeat(40);
        const desiredSourceSha = execFileSync(
            'git',
            ['rev-parse', '--verify', 'HEAD^{commit}'],
            { cwd: root, encoding: 'utf8', timeout: CHILD_PROCESS_TIMEOUT_MS },
        ).trim();
        const result = fakeRun({ observedSourceSha: oldSourceSha, args: ['--apply'] });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.calls).toContain('run deploy');
        expect(result.calls).toContain('run services update-traffic');
        expect(result.stdout).toContain('predeploy: allowing an older valid Cloud Run source provenance label');
        expect((result.finalService.metadata as { labels: Record<string, string> }).labels['analysis-v2-source-commit'])
            .toBe(desiredSourceSha);
    });

    it('allows only the preflight initial slot pool to roll forward with an older source during apply predeploy', () => {
        const result = fakeRun({
            role: 'preflight',
            observedSourceSha: 'd'.repeat(40),
            serviceEnv: {
                PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary',
            },
            args: ['--apply'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.calls).toContain('run deploy');
        expect(result.calls).toContain('run services update-traffic');
        expect(result.stdout).toContain('predeploy: allowing exact preflight Apify slot-pool roll-forward');
        const finalEnv = (result.finalService.spec as {
            template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } };
        }).template.spec.containers[0].env;
        expect(finalEnv.find(({ name }) => name === 'PREFLIGHT_APIFY_API_TOKEN_SLOTS')?.value)
            .toBe('primary,tertiary,quaternary,quinary,senary,septenary,octonary,nonary,tenth');
    });

    it('allows only the exact additive preflight Secret Manager ref set with the known old ref contract', () => {
        const exactPreflightVersions = {
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'primary',
            ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION: '3',
            ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION: '1',
            ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION: '1',
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION: '1',
            ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION: '1',
            ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS: 'tertiary:1,quaternary:1,quinary:1,senary:1,septenary:1,octonary:1,nonary:1,tenth:1',
        };
        const result = fakeRun({
            role: 'preflight',
            environment: exactPreflightVersions,
            observedSourceSha: KNOWN_PREFLIGHT_OLD_SOURCE_SHA,
            serviceEnv: {
                PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary',
                APIFY_TERTIARY_API_TOKEN: null,
                APIFY_QUATERNARY_API_TOKEN: null,
                APIFY_SEPTENARY_API_TOKEN: null,
                APIFY_OCTONARY_API_TOKEN: null,
                APIFY_NONARY_API_TOKEN: null,
                APIFY_TENTH_API_TOKEN: null,
            },
            args: ['--apply'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.stdout).toContain('predeploy: allowing exact additive preflight Apify Secret Manager refs');
        expect(result.calls).toContain('run deploy');
        expect(result.calls).toContain('run services update-traffic');
        const finalSecretNames = ((result.finalService.spec as {
            template: { spec: { containers: Array<{ env: Array<{ name: string; valueFrom?: unknown }> }> } };
        }).template.spec.containers[0].env)
            .filter(({ name, valueFrom }) => name.startsWith('APIFY_') && valueFrom)
            .map(({ name }) => name)
            .sort();
        expect(finalSecretNames).toEqual([
            'APIFY_NONARY_API_TOKEN',
            'APIFY_OCTONARY_API_TOKEN',
            'APIFY_PRIMARY_API_TOKEN',
            'APIFY_QUATERNARY_API_TOKEN',
            'APIFY_QUINARY_API_TOKEN',
            'APIFY_SENARY_API_TOKEN',
            'APIFY_SEPTENARY_API_TOKEN',
            'APIFY_TENTH_API_TOKEN',
            'APIFY_TERTIARY_API_TOKEN',
        ]);
    });

    it.each([
        ['altered old ref', {
            role: 'preflight' as const,
            environment: {
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'primary',
                ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION: '3',
                ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION: '1',
                ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION: '1',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS: 'tertiary:1,quaternary:1,quinary:1,senary:1,septenary:1,octonary:1,nonary:1,tenth:1',
            },
            observedSourceSha: KNOWN_PREFLIGHT_OLD_SOURCE_SHA,
            serviceEnv: {
                PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary',
                APIFY_QUINARY_API_TOKEN: 'wrong-secret-ref-version',
                APIFY_TERTIARY_API_TOKEN: null,
                APIFY_QUATERNARY_API_TOKEN: null,
                APIFY_SEPTENARY_API_TOKEN: null,
                APIFY_OCTONARY_API_TOKEN: null,
                APIFY_NONARY_API_TOKEN: null,
                APIFY_TENTH_API_TOKEN: null,
            },
            args: ['--apply'],
        }, 'Cloud Run required Secret Manager ref drifted for APIFY_TERTIARY_API_TOKEN'],
        ['extra secondary ref', {
            role: 'preflight' as const,
            environment: {
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'primary',
                ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION: '3',
                ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION: '1',
                ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION: '1',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS: 'tertiary:1,quaternary:1,quinary:1,senary:1,septenary:1,octonary:1,nonary:1,tenth:1',
            },
            observedSourceSha: KNOWN_PREFLIGHT_OLD_SOURCE_SHA,
            serviceEnv: {
                PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary',
                APIFY_SECONDARY_API_TOKEN: 'unexpected-secret-ref',
                APIFY_TERTIARY_API_TOKEN: null,
                APIFY_QUATERNARY_API_TOKEN: null,
                APIFY_SEPTENARY_API_TOKEN: null,
                APIFY_OCTONARY_API_TOKEN: null,
                APIFY_NONARY_API_TOKEN: null,
                APIFY_TENTH_API_TOKEN: null,
            },
            args: ['--apply'],
        }, 'Cloud Run required Secret Manager ref drifted for APIFY_TERTIARY_API_TOKEN'],
        ['missing old primary ref', {
            role: 'preflight' as const,
            environment: {
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'primary',
                ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION: '3',
                ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION: '1',
                ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION: '1',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS: 'tertiary:1,quaternary:1,quinary:1,senary:1,septenary:1,octonary:1,nonary:1,tenth:1',
            },
            observedSourceSha: KNOWN_PREFLIGHT_OLD_SOURCE_SHA,
            serviceEnv: {
                PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary',
                APIFY_PRIMARY_API_TOKEN: null,
                APIFY_TERTIARY_API_TOKEN: null,
                APIFY_QUATERNARY_API_TOKEN: null,
                APIFY_SEPTENARY_API_TOKEN: null,
                APIFY_OCTONARY_API_TOKEN: null,
                APIFY_NONARY_API_TOKEN: null,
                APIFY_TENTH_API_TOKEN: null,
            },
            args: ['--apply'],
        }, 'Cloud Run required Secret Manager ref drifted for APIFY_PRIMARY_API_TOKEN'],
        ['altered desired version', {
            role: 'preflight' as const,
            environment: {
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'primary',
                ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION: '3',
                ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION: '1',
                ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION: '1',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS: 'tertiary:2,quaternary:1,quinary:1,senary:1,septenary:1,octonary:1,nonary:1,tenth:1',
            },
            observedSourceSha: KNOWN_PREFLIGHT_OLD_SOURCE_SHA,
            serviceEnv: {
                PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary',
                APIFY_TERTIARY_API_TOKEN: null,
                APIFY_QUATERNARY_API_TOKEN: null,
                APIFY_SEPTENARY_API_TOKEN: null,
                APIFY_OCTONARY_API_TOKEN: null,
                APIFY_NONARY_API_TOKEN: null,
                APIFY_TENTH_API_TOKEN: null,
            },
            args: ['--apply'],
        }, 'Cloud Run required Secret Manager ref drifted for APIFY_TERTIARY_API_TOKEN'],
        ['wrong role', {
            role: 'paid' as const,
            environment: {
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'secondary',
                ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION: '4',
                ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION: '1',
                ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION: '1',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION: '1',
                ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS: 'primary:3,tertiary:1,quaternary:1,quinary:1,senary:1,septenary:1,octonary:1,nonary:1,tenth:1',
            },
            observedSourceSha: KNOWN_PREFLIGHT_OLD_SOURCE_SHA,
            serviceEnv: {
                APIFY_TERTIARY_API_TOKEN: null,
            },
            args: ['--apply'],
        }, 'paid Secret Manager ref roll-forward requires the exact reviewed eight-ref starting set'],
    ] as const)('rejects non-exact preflight Secret Manager roll-forward: %s', (_name, options, expected) => {
        const result = fakeRun(options);
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
        expect(result.calls).not.toContain('run deploy');
    });

    it('allows the exact additive paid Secret Manager ref set for a valid new source candidate', () => {
        const candidateSourceSha = execFileSync(
            'git',
            ['rev-parse', '--verify', 'HEAD^{commit}'],
            { cwd: root, encoding: 'utf8', timeout: CHILD_PROCESS_TIMEOUT_MS },
        ).trim();
        expect(candidateSourceSha).toMatch(/^[0-9a-f]{40}$/);
        const exactPaidVersions = {
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'secondary',
            ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION: '4',
            ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION: '1',
            ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION: '1',
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION: '1',
            ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION: '1',
            ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS: 'primary:3,tertiary:1,quaternary:1,quinary:1,senary:1,septenary:1,octonary:1,nonary:1,tenth:1',
        };
        const result = fakeRun({
            role: 'paid',
            environment: exactPaidVersions,
            observedSourceSha: KNOWN_PAID_OLD_SOURCE_SHA,
            serviceEnv: {
                APIFY_OCTONARY_API_TOKEN: null,
                APIFY_NONARY_API_TOKEN: null,
            },
            args: ['--apply'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.stdout).toContain('predeploy: allowing exact additive paid Apify Secret Manager refs');
        expect(result.calls).toContain('run deploy');
        expect(result.calls).toContain('run services update-traffic');
        expect((result.finalService.metadata as {
            labels: { 'analysis-v2-source-commit': string };
        }).labels['analysis-v2-source-commit']).toBe(candidateSourceSha);
        const finalSecretNames = ((result.finalService.spec as {
            template: { spec: { containers: Array<{ env: Array<{ name: string; valueFrom?: unknown }> }> } };
        }).template.spec.containers[0].env)
            .filter(({ name, valueFrom }) => name.startsWith('APIFY_') && valueFrom)
            .map(({ name }) => name)
            .sort();
        expect(finalSecretNames).toEqual([
            'APIFY_NONARY_API_TOKEN',
            'APIFY_OCTONARY_API_TOKEN',
            'APIFY_PRIMARY_API_TOKEN',
            'APIFY_QUATERNARY_API_TOKEN',
            'APIFY_QUINARY_API_TOKEN',
            'APIFY_SECONDARY_API_TOKEN',
            'APIFY_SENARY_API_TOKEN',
            'APIFY_SEPTENARY_API_TOKEN',
            'APIFY_TENTH_API_TOKEN',
            'APIFY_TERTIARY_API_TOKEN',
        ]);
    });

    it('allows a later valid source to roll forward normally when paid refs are already complete', () => {
        const result = fakeRun({
            role: 'paid',
            observedSourceSha: 'd'.repeat(40),
            args: ['--apply'],
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.stdout).not.toContain('predeploy: allowing exact additive paid Apify Secret Manager refs');
        expect(result.calls).toContain('run deploy');
        expect(result.calls).toContain('run services update-traffic');
    });

    it.each([
        ['altered existing ref', {
            role: 'paid' as const,
            observedSourceSha: KNOWN_PAID_OLD_SOURCE_SHA,
            serviceEnv: {
                APIFY_TERTIARY_API_TOKEN: 'unexpected-plaintext-ref',
                APIFY_OCTONARY_API_TOKEN: null,
                APIFY_NONARY_API_TOKEN: null,
            },
            args: ['--apply'],
        }, 'paid Secret Manager ref roll-forward requires the exact reviewed eight-ref starting set'],
        ['missing existing ref', {
            role: 'paid' as const,
            observedSourceSha: KNOWN_PAID_OLD_SOURCE_SHA,
            serviceEnv: {
                APIFY_PRIMARY_API_TOKEN: null,
                APIFY_OCTONARY_API_TOKEN: null,
                APIFY_NONARY_API_TOKEN: null,
            },
            args: ['--apply'],
        }, 'paid Secret Manager ref roll-forward requires the exact reviewed eight-ref starting set'],
        ['extra ref', {
            role: 'paid' as const,
            observedSourceSha: KNOWN_PAID_OLD_SOURCE_SHA,
            serviceEnv: {
                APIFY_EXTRA_SLOT_API_TOKEN: 'unexpected-secret-ref',
            },
            args: ['--apply'],
        }, 'paid Secret Manager ref roll-forward requires the exact reviewed eight-ref starting set'],
        ['secret ref version mismatch', {
            role: 'paid' as const,
            observedSourceSha: KNOWN_PAID_OLD_SOURCE_SHA,
            serviceOverrides: {
                spec: {
                    template: {
                        spec: {
                            containers: [{
                                env: [{
                                    name: 'APIFY_TERTIARY_API_TOKEN',
                                    valueFrom: { secretKeyRef: { key: '2' } },
                                }],
                            }],
                        },
                    },
                },
            },
            args: ['--apply'],
        }, 'paid Secret Manager ref roll-forward requires the exact reviewed eight-ref starting set'],
        ['later source with incomplete refs', {
            role: 'paid' as const,
            observedSourceSha: 'd'.repeat(40),
            serviceEnv: { APIFY_TERTIARY_API_TOKEN: null },
            args: ['--apply'],
        }, 'Cloud Run required Secret Manager ref drifted for APIFY_TERTIARY_API_TOKEN'],
        ['malformed source', {
            role: 'paid' as const,
            observedSourceSha: 'not-a-git-sha',
            args: ['--apply'],
        }, 'source provenance'],
        ['wrong role', {
            role: 'paid' as const,
            observedSourceSha: KNOWN_PAID_OLD_SOURCE_SHA,
            serviceOverrides: { metadata: { labels: { 'analysis-workload-role': 'preflight' } } },
            args: ['--apply'],
        }, 'workload-role label'],
        ['check mode', {
            role: 'paid' as const,
            observedSourceSha: KNOWN_PAID_OLD_SOURCE_SHA,
            args: ['--check'],
        }, 'source provenance'],
        ['unsafe stage transition', {
            role: 'paid' as const,
            observedSourceSha: KNOWN_PAID_OLD_SOURCE_SHA,
            serviceStage: 'expanded' as const,
            args: ['--apply'],
        }, 'unsafe capacity stage transition'],
        ['non-100-percent serving traffic', {
            role: 'paid' as const,
            observedSourceSha: KNOWN_PAID_OLD_SOURCE_SHA,
            serviceOverrides: {
                status: {
                    traffic: [
                        { revisionName: 'analysis-paid-worker-00001-abc', percent: 50 },
                        { revisionName: 'analysis-paid-worker-00000-old', percent: 50 },
                    ],
                },
            },
            args: ['--apply'],
        }, 'latest ready revision at 100 percent'],
    ] as const)('keeps paid secret ref roll-forward fail-closed for %s', (_name, options, expected) => {
        const result = fakeRun(options);
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
        expect(result.calls).not.toContain('run deploy');
    });

    it.each([
        ['check mode', {
            role: 'preflight' as const,
            observedSourceSha: KNOWN_PREFLIGHT_OLD_SOURCE_SHA,
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' },
            args: ['--check'],
        }, 'source provenance'],
        ['malformed observed SHA', {
            role: 'preflight' as const,
            observedSourceSha: 'not-a-git-sha',
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' },
            args: ['--apply'],
        }, 'source provenance'],
        ['same source SHA', {
            role: 'preflight' as const,
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' },
            args: ['--apply'],
        }, 'observed environment drifted for PREFLIGHT_APIFY_API_TOKEN_SLOTS'],
        ['wrong old slot list', {
            role: 'preflight' as const,
            observedSourceSha: 'd'.repeat(40),
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary' },
            args: ['--apply'],
        }, 'observed environment drifted for PREFLIGHT_APIFY_API_TOKEN_SLOTS'],
        ['wrong desired slot list', {
            role: 'preflight' as const,
            observedSourceSha: 'd'.repeat(40),
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' },
            manifestOverrides: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,tertiary,quinary' },
            args: ['--apply'],
        }, 'observed environment drifted for PREFLIGHT_APIFY_API_TOKEN_SLOTS'],
        ['missing slot list', {
            role: 'preflight' as const,
            observedSourceSha: 'd'.repeat(40),
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: null },
            args: ['--apply'],
        }, 'observed environment drifted for PREFLIGHT_APIFY_API_TOKEN_SLOTS'],
        ['wrong role', {
            role: 'paid' as const,
            observedSourceSha: 'd'.repeat(40),
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' },
            manifestOverrides: {
                PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,tertiary,quaternary,quinary,senary,septenary,octonary,nonary,tenth',
            },
            args: ['--apply'],
        }, 'observed environment drifted for PREFLIGHT_APIFY_API_TOKEN_SLOTS'],
        ['unsafe stage transition', {
            role: 'preflight' as const,
            observedSourceSha: 'd'.repeat(40),
            serviceStage: 'expanded' as const,
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' },
            args: ['--apply'],
        }, 'unsafe capacity stage transition'],
        ['non-100-percent serving traffic', {
            role: 'preflight' as const,
            observedSourceSha: 'd'.repeat(40),
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' },
            serviceOverrides: {
                status: {
                    traffic: [
                        { revisionName: 'analysis-preflight-worker-00001-abc', percent: 50 },
                        { revisionName: 'analysis-preflight-worker-00000-old', percent: 50 },
                    ],
                },
            },
            args: ['--apply'],
        }, 'latest ready revision at 100 percent'],
        ['protected admission gate drift', {
            role: 'preflight' as const,
            observedSourceSha: 'd'.repeat(40),
            serviceEnv: {
                PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary',
                ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'false',
            },
            args: ['--apply'],
        }, 'observed admission gate is not true'],
    ] as const)('keeps preflight slot roll-forward fail-closed for %s', (_name, options, expected) => {
        const result = fakeRun(options);
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
        expect(result.calls).not.toContain('run deploy');
    });

    it('rejects a preflight staged revision whose source provenance does not match the desired SHA', () => {
        const result = fakeRun({
            role: 'preflight',
            observedSourceSha: 'd'.repeat(40),
            stagedSourceSha: 'e'.repeat(40),
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' },
            args: ['--apply'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('exact Ready revision for this service');
        expect(result.calls).not.toContain('run services update-traffic');
    });

    it('rejects preflight post-promotion source provenance drift after the new revision reaches 100 percent traffic', () => {
        const result = fakeRun({
            role: 'preflight',
            observedSourceSha: 'd'.repeat(40),
            postDeploySourceSha: 'e'.repeat(40),
            serviceEnv: { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' },
            args: ['--apply'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('source provenance');
        expect(result.calls.match(/run services update-traffic/g) ?? []).toHaveLength(2);
    });

    it.each([
        ['check mode', { args: ['--check'] }, 'source provenance'],
        ['malformed observed SHA', { args: ['--apply'], observedSourceSha: 'not-a-git-sha' }, 'source provenance'],
        ['wrong role', {
            args: ['--apply'],
            serviceOverrides: { metadata: { labels: { 'analysis-workload-role': 'preflight' } } },
        }, 'workload-role label'],
        ['unsafe stage transition', { args: ['--apply'], serviceStage: 'expanded' as const }, 'unsafe capacity stage transition'],
        ['non-100-percent serving traffic', {
            args: ['--apply'],
            serviceOverrides: {
                status: {
                    traffic: [
                        { revisionName: 'analysis-paid-worker-00001-abc', percent: 50 },
                        { revisionName: 'analysis-paid-worker-00000-old', percent: 50 },
                    ],
                },
            },
        }, 'latest ready revision at 100 percent'],
    ] as const)('keeps source roll-forward fail-closed for %s', (_name, options, expected) => {
        const result = fakeRun({ observedSourceSha: 'd'.repeat(40), ...options });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
        expect(result.calls).not.toContain('run deploy');
    });

    it('rejects a staged revision whose source provenance does not match the desired SHA', () => {
        const result = fakeRun({
            observedSourceSha: 'd'.repeat(40),
            stagedSourceSha: 'e'.repeat(40),
            args: ['--apply'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('exact Ready revision for this service');
        expect(result.calls).not.toContain('run services update-traffic');
    });

    it('rejects post-promotion source provenance drift after the new revision reaches 100 percent traffic', () => {
        const result = fakeRun({
            observedSourceSha: 'd'.repeat(40),
            postDeploySourceSha: 'e'.repeat(40),
            args: ['--apply'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('source provenance');
        expect(result.calls.match(/run services update-traffic/g) ?? []).toHaveLength(2);
    });

    it.each([
        ['preflight gate', { role: 'preflight' as const, serviceOverrides: { spec: { template: { spec: { containers: [{ env: [{ name: 'PREFLIGHT_TASKS_ENABLED', value: 'false' }] }] } } } } }, 'role enable gate'],
        ['paid task gate', { role: 'paid' as const, serviceOverrides: { spec: { template: { spec: { containers: [{ env: [{ name: 'ANALYSIS_V2_TASKS_ENABLED', value: 'false' }] }] } } } } }, 'role enable gate'],
        ['paid worker gate', { role: 'paid' as const, serviceOverrides: { spec: { template: { spec: { containers: [{ env: [{ name: 'ANALYSIS_V2_WORKER_ENABLED', value: 'false' }] }] } } } } }, 'role enable gate'],
    ] as const)('rejects missing/false readiness gate: %s', (_name, options, expected) => {
        const result = fakeRun({ ...options, args: ['--check'] });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
    });

    // The production-shaped drift: an existing initial-stage service still runs
    // the prior task caller and runtime identities and carries no enqueuer env
    // at all, while the reviewed manifest names the rotated three-identity set.
    function identityRollForwardRun(
        role: 'preflight' | 'paid',
        overrides: FakeRunOptions = {},
    ) {
        const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
        const maintenancePrefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2';
        const env = { ...baseEnvironment(role), ...(overrides.environment ?? {}) };
        const enqueuerKey = `${prefix}_ENQUEUER_SERVICE_ACCOUNT_EMAIL`;
        const desiredEnqueuer = env[enqueuerKey as keyof typeof env] as string;
        const maintenance = env[`${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL` as keyof typeof env] as string;
        const old = OLD_IDENTITIES[role];
        const defaults: FakeRunOptions = {
            role,
            observedSourceSha: OLD_IDENTITY_SOURCE_SHA,
            manifestOverrides: { [enqueuerKey]: desiredEnqueuer },
            serviceEnv: { [`${prefix}_SERVICE_ACCOUNT_EMAIL`]: old.task },
            serviceOverrides: { spec: { template: { spec: { serviceAccountName: old.runtime } } } },
            iam: {
                version: 1,
                etag: 'BwXfixture01=',
                bindings: [
                    { role: 'roles/viewer', members: ['serviceAccount:unrelated@example-project.iam.gserviceaccount.com'] },
                    { role: 'roles/run.invoker', members: [
                        `serviceAccount:${old.task}`,
                        `serviceAccount:${maintenance}`,
                    ] },
                ],
            },
            queueTasks: [],
            // The rollout pauses the every-minute recovery scheduler and waits
            // out the quiescence window before invoking the guarded path.
            schedulerJob: { state: 'PAUSED' },
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL: old.task,
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_ENQUEUER_SERVICE_ACCOUNT_EMAIL: 'absent',
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_RUNTIME_SERVICE_ACCOUNT_EMAIL: old.runtime,
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_SOURCE_SHA: OLD_IDENTITY_SOURCE_SHA,
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH: agedPauseEpoch(),
            },
            args: ['--apply', '--reconcile-iam', '--allow-initial-identity-roll-forward'],
        };
        return fakeRun({
            ...defaults,
            ...overrides,
            environment: { ...defaults.environment, ...overrides.environment },
            serviceEnv: { ...defaults.serviceEnv, ...overrides.serviceEnv },
            manifestOverrides: { ...defaults.manifestOverrides, ...overrides.manifestOverrides },
            serviceOverrides: deepMerge(defaults.serviceOverrides, overrides.serviceOverrides ?? {}),
        });
    }

    function serviceIdentities(finalService: Record<string, unknown>, role: 'preflight' | 'paid') {
        const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
        const template = (finalService.spec as {
            template: {
                spec: {
                    serviceAccountName: string;
                    containers: Array<{ env: Array<{ name: string; value?: string }> }>;
                };
            };
        }).template;
        const value = (name: string) => template.spec.containers[0].env
            .find((entry) => entry.name === name)?.value;
        return {
            task: value(`${prefix}_SERVICE_ACCOUNT_EMAIL`),
            enqueuer: value(`${prefix}_ENQUEUER_SERVICE_ACCOUNT_EMAIL`),
            runtime: template.spec.serviceAccountName,
        };
    }

    it('rolls an existing initial preflight service forward onto rotated task, enqueuer, and runtime identities', () => {
        const base = baseEnvironment('preflight');
        const result = identityRollForwardRun('preflight');
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.stdout).toContain(
            'verified: initial identity roll-forward preconditions before any service, IAM, or deploy mutation',
        );
        expect(result.stdout).toContain('predeploy: allowing exact initial task caller identity roll-forward');
        expect(result.stdout).toContain('predeploy: allowing exact initial runtime identity roll-forward');
        expect(result.stdout).toContain(
            'predeploy: allowing exact initial identity roll-forward for PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL',
        );
        expect(result.calls).toContain('run deploy');
        expect(result.calls).toContain('run services update-traffic');
        expect(serviceIdentities(result.finalService, 'preflight')).toEqual({
            task: base.PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL,
            enqueuer: base.PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL,
            runtime: base.PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL,
        });
        const invokers = (result.finalIam.bindings as Array<{ role: string; members: string[] }>)
            .find((binding) => binding.role === 'roles/run.invoker');
        expect(invokers?.members).toEqual([
            `serviceAccount:${base.PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL}`,
            `serviceAccount:${base.PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL}`,
        ]);
        expect(invokers?.members).not.toContain(`serviceAccount:${OLD_IDENTITIES.preflight.task}`);
    });

    it('proves the desired preflight producer fingerprint and paused empty queue precede every IAM and deploy mutation', () => {
        const result = identityRollForwardRun('preflight');
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        const lines = result.calls.split('\n');
        const indexOf = (predicate: (line: string) => boolean) => lines.findIndex(predicate);
        const readinessIndex = indexOf((line) => line.startsWith('curl ') && line.includes('/api/analysis/capacity/readiness'));
        const targetQueueIndex = indexOf((line) => line.startsWith('tasks queues describe analysis-preflight'));
        const deploymentsIndex = indexOf((line) => line.startsWith('curl ') && line.includes('/v6/deployments'));
        const aliasesIndex = indexOf((line) => line.startsWith('curl ') && line.includes('/aliases'));
        const nextEnvIndex = indexOf((line) => line.startsWith('curl ') && line.includes('/v10/projects/'));
        const iamPolicyReadIndex = indexOf((line) => line.startsWith('run services get-iam-policy'));
        const iamMutationIndex = indexOf((line) => line.startsWith('run services set-iam-policy'));
        const deployIndex = indexOf((line) => line.startsWith('run deploy'));
        for (const index of [
            readinessIndex, targetQueueIndex, deploymentsIndex, aliasesIndex,
            nextEnvIndex, iamPolicyReadIndex, iamMutationIndex, deployIndex,
        ]) {
            expect(index).toBeGreaterThanOrEqual(0);
        }
        // Every piece of evidence — paused/empty target queue, the complete
        // published Vercel deployment chain, and the prior invoker binding —
        // is observed before the IAM reconcile and before the deploy.
        for (const evidenceIndex of [
            readinessIndex, targetQueueIndex, deploymentsIndex, aliasesIndex,
            nextEnvIndex, iamPolicyReadIndex,
        ]) {
            expect(evidenceIndex).toBeLessThan(iamMutationIndex);
            expect(evidenceIndex).toBeLessThan(deployIndex);
        }
        expect(iamMutationIndex).toBeLessThan(deployIndex);
    });

    // Public readiness v2 exposes producer fingerprints for both role
    // contracts. The exceptional flag remains preflight-only because only that
    // transition was reviewed/authorized and the production audit found no
    // paid identity rotation need; it is refused for paid before observation.
    it('refuses the exceptional identity roll-forward for the paid role before observing anything', () => {
        const result = identityRollForwardRun('paid');
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`)
            .toContain('--allow-initial-identity-roll-forward is valid only for --role=preflight');
        expect(result.calls).toBe('');
    });

    const paidExactnessCases: Array<[string, Record<string, string | null>, string]> = [
        ['task caller', {
            ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: OLD_IDENTITIES.paid.task,
        }, 'Cloud Run observed task identity drifted'],
        ['target URL', {
            ANALYSIS_V2_TASKS_TARGET_URL: 'https://stale.example.com/api/analysis/v2/worker',
        }, 'Cloud Run observed target URL drifted'],
        ['OIDC audience', {
            ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://stale.example.com',
        }, 'Cloud Run observed OIDC audience drifted'],
    ];

    it.each(paidExactnessCases)(
        'keeps the ordinary paid apply exact for %s drift',
        (_name, serviceEnv, expected) => {
            const result = fakeRun({
                role: 'paid',
                serviceEnv,
                args: ['--apply', '--reconcile-iam'],
            });
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run deploy');
            expect(result.calls).not.toContain('run services set-iam-policy');
        },
    );

    const unauthorizedIdentityRollForwardCases: Array<[string, FakeRunOptions, string]> = [
        ['check mode', { args: ['--check', '--allow-initial-identity-roll-forward'] },
            '--allow-initial-identity-roll-forward requires explicit --apply'],
        ['dry-run mode', { args: ['--dry-run', '--allow-initial-identity-roll-forward'] },
            '--allow-initial-identity-roll-forward requires explicit --apply'],
        ['implicit apply', { args: ['--allow-initial-identity-roll-forward'] },
            '--allow-initial-identity-roll-forward requires explicit --apply'],
        ['missing reconcile-iam', { args: ['--apply', '--allow-initial-identity-roll-forward'] },
            '--allow-initial-identity-roll-forward requires --reconcile-iam'],
        ['expanded target stage', { stage: 'expanded' },
            '--allow-initial-identity-roll-forward requires target stage=initial'],
        ['bootstrap target stage', { stage: 'bootstrap' },
            '--allow-initial-identity-roll-forward requires target stage=initial'],
        ['combined with the bootstrap transition', {
            args: ['--apply', '--reconcile-iam', '--allow-initial-identity-roll-forward',
                '--allow-bootstrap-initial-transition'],
        }, 'cannot combine'],
        ['missing prior task assertion', {
            environment: { ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL: '' },
        }, 'requires exact prior task, enqueuer, runtime, and source SHA assertions'],
        ['missing prior enqueuer assertion', {
            environment: { ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_ENQUEUER_SERVICE_ACCOUNT_EMAIL: '' },
        }, 'requires exact prior task, enqueuer, runtime, and source SHA assertions'],
        ['missing prior runtime assertion', {
            environment: { ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_RUNTIME_SERVICE_ACCOUNT_EMAIL: '' },
        }, 'requires exact prior task, enqueuer, runtime, and source SHA assertions'],
        ['missing prior source SHA assertion', {
            environment: { ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_SOURCE_SHA: '' },
        }, 'requires exact prior task, enqueuer, runtime, and source SHA assertions'],
        ['malformed prior source SHA', {
            environment: { ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_SOURCE_SHA: 'not-a-git-sha' },
        }, 'prior source SHA must be one exact 40-character commit'],
        ['prior identity aliases a desired identity', {
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL:
                    'preflight-runtime@example-project.iam.gserviceaccount.com',
            },
        }, 'must differ from every desired workload identity'],
        ['prior identities alias each other', {
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_RUNTIME_SERVICE_ACCOUNT_EMAIL:
                    OLD_IDENTITIES.preflight.task,
            },
        }, 'prior identities must be pairwise distinct'],
        ['prior identity outside the task project', {
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL:
                    'preflight-task-legacy@other-project.iam.gserviceaccount.com',
            },
        }, 'prior identities must belong to the task project'],
        ['aliased desired workload identities', {
            environment: {
                PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL:
                    'preflight-task@example-project.iam.gserviceaccount.com',
            },
        }, 'task, enqueuer, and runtime identities must be distinct'],
        ['manifest without the desired enqueuer identity', {
            manifestOverrides: { PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL: undefined },
        }, 'requires the runtime manifest to carry the desired PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL'],
    ];

    it.each(unauthorizedIdentityRollForwardCases)(
        'rejects an unauthorized initial identity roll-forward before observing anything: %s',
        (_name, overrides, expected) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).toBe('');
        },
    );

    const failClosedIdentityRollForwardCases: Array<[string, FakeRunOptions, string]> = [
        ['observed bootstrap service', { serviceStage: 'bootstrap' },
            '--allow-initial-identity-roll-forward requires an observed initial service'],
        ['running target queue', { targetQueue: { state: 'RUNNING' } },
            'requires the exact PAUSED target queue'],
        ['foreign target queue name', {
            targetQueue: { name: 'projects/example-project/locations/asia-northeast3/queues/somewhere-else' },
        }, 'requires the exact PAUSED target queue'],
        ['unobservable target queue', { targetQueue: 'unobservable' },
            'target queue could not be observed'],
        ['non-empty target queue', { queueTasks: undefined },
            'requires an empty target queue'],
        ['wrong prior task assertion', {
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL:
                    'preflight-task-other@example-project.iam.gserviceaccount.com',
            },
        }, 'prior task identity assertion does not match the observed service'],
        ['wrong prior runtime assertion', {
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_RUNTIME_SERVICE_ACCOUNT_EMAIL:
                    'preflight-runtime-other@example-project.iam.gserviceaccount.com',
            },
        }, 'prior runtime identity assertion does not match the observed service'],
        ['prior enqueuer asserted absent while one is observed', {
            serviceEnv: {
                PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL:
                    'preflight-enqueuer-legacy@example-project.iam.gserviceaccount.com',
            },
        }, 'prior enqueuer identity assertion does not match the observed service'],
        ['prior enqueuer asserted present while none is observed', {
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_ENQUEUER_SERVICE_ACCOUNT_EMAIL:
                    'preflight-enqueuer-legacy@example-project.iam.gserviceaccount.com',
            },
        }, 'prior enqueuer identity assertion does not match the observed service'],
        ['wrong prior source SHA assertion', {
            environment: { ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_SOURCE_SHA: 'b'.repeat(40) },
        }, 'prior source SHA assertion does not match the observed service'],
        ['misaligned preflight producer fingerprint', {
            publicFreeze: { preflightProducerConfigFingerprint: 'f'.repeat(64) },
        }, 'producer fingerprint does not match the reviewed contract'],
        ['unready preflight producer configuration', {
            publicFreeze: { preflightProducerConfigReady: false },
        }, 'public freeze readiness failed strict v3 wire validation'],
    ];

    it.each(failClosedIdentityRollForwardCases)(
        'keeps the initial identity roll-forward fail-closed before any service/IAM/deploy mutation: %s',
        (_name, overrides, expected) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run deploy');
            expect(result.calls).not.toContain('run services set-iam-policy');
        },
    );

    const unrelatedDriftIdentityRollForwardCases: Array<[string, FakeRunOptions, string]> = [
        ['maintenance identity drift', {
            serviceEnv: {
                PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL:
                    'preflight-maintenance-old@example-project.iam.gserviceaccount.com',
            },
        }, 'observed maintenance identity drifted'],
        ['maintenance audience drift', {
            serviceEnv: { PREFLIGHT_TASKS_MAINTENANCE_OIDC_AUDIENCE: 'https://stale.example.com' },
        }, 'observed maintenance audience drifted'],
        ['queue drift', {
            serviceEnv: { PREFLIGHT_TASKS_QUEUE: 'analysis-preflight-legacy' },
        }, 'observed queue drifted'],
        ['target URL drift', {
            serviceEnv: { PREFLIGHT_TASKS_TARGET_URL: 'https://stale.example.com/api/analysis/preflight/worker' },
        }, 'observed target URL drifted'],
        ['unrelated env drift', {
            serviceEnv: { ANALYSIS_CAPACITY_WORKER_MEMORY: '1Gi' },
        }, 'observed environment drifted for ANALYSIS_CAPACITY_WORKER_MEMORY'],
        ['admission gate drift', {
            serviceEnv: { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'false' },
        }, 'observed admission gate is not true'],
    ];

    it.each(unrelatedDriftIdentityRollForwardCases)(
        'never widens the initial identity roll-forward into other drift: %s',
        (_name, overrides, expected) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run deploy');
        },
    );

    // Correction 2: the exceptional path must clear the complete published
    // Vercel evidence chain - selected READY deployment SHA, exact alias/origin
    // binding, next-deploy env metadata, and the active runtime fingerprint -
    // before the IAM reconcile or the deploy, not the fingerprint alone.
    const vercelEvidenceCases: Array<[string, FakeRunOptions, string]> = [
        ['production SHA mismatch', {
            vercelDeployments: {
                deployments: [{
                    uid: 'dpl_fixture',
                    url: 'vercel-fixture.example.com',
                    target: 'production',
                    readyState: 'READY',
                    meta: { githubCommitSha: 'e'.repeat(40) },
                }],
            },
        }, 'Vercel production SHA does not match the deployed source SHA'],
        ['no ready production deployment', {
            vercelDeployments: {
                deployments: [{
                    uid: 'dpl_fixture',
                    url: 'vercel-fixture.example.com',
                    target: 'production',
                    readyState: 'BUILDING',
                    meta: { githubCommitSha: 'e'.repeat(40) },
                }],
            },
        }, 'Vercel has no ready production deployment record'],
        ['alias/origin does not bind the selected deployment', {
            vercelAliases: {
                aliases: [{ uid: 'alias_fixture', alias: 'unrelated.example.com', created: '2026-08-01T00:00:00.000Z' }],
            },
        }, 'public freeze origin does not match the selected READY Vercel deployment URL or exact alias'],
        ['next-deploy env metadata is missing the producer caller key', {
            vercelProjectEnvironment: {
                envs: [
                    { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 0,
            },
        }, 'next-deploy Vercel preflight environment is missing required production keys'],
        ['hidden production env values', {
            vercelProjectEnvironment: {
                envs: [
                    { key: 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_TARGET_URL', target: ['production'] },
                    { key: 'PREFLIGHT_TASKS_OIDC_AUDIENCE', target: ['production'] },
                ],
                hiddenProductionEnvCount: 2,
            },
        }, 'next-deploy Vercel preflight environment has hidden production values'],
    ];

    it.each(vercelEvidenceCases)(
        'requires the full published Vercel evidence chain before any service/IAM/deploy mutation: %s',
        (_name, overrides, expected) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    // Correction 3: the prior invoker binding itself is reviewed evidence.  The
    // rotation may only replace exactly {asserted old caller, unchanged current
    // maintenance caller}; anything else must be refused before set-iam-policy.
    const PREFLIGHT_MAINTENANCE = 'preflight-maintenance@example-project.iam.gserviceaccount.com';
    const oldInvokerBinding = (members: string[], extra: Record<string, unknown> = {}) => ({
        version: 1,
        etag: 'BwXfixture01=',
        bindings: [
            { role: 'roles/viewer', members: ['serviceAccount:unrelated@example-project.iam.gserviceaccount.com'] },
            { role: 'roles/run.invoker', members, ...extra },
        ],
    });

    const oldInvokerIamCases: Array<[string, FakeRunOptions, string]> = [
        ['an extra third member', {
            iam: oldInvokerBinding([
                `serviceAccount:${OLD_IDENTITIES.preflight.task}`,
                `serviceAccount:${PREFLIGHT_MAINTENANCE}`,
                'serviceAccount:stale@example-project.iam.gserviceaccount.com',
            ]),
        }, 'prior invoker binding'],
        ['a public member', {
            iam: oldInvokerBinding([
                `serviceAccount:${OLD_IDENTITIES.preflight.task}`,
                `serviceAccount:${PREFLIGHT_MAINTENANCE}`,
                'allUsers',
            ]),
        }, 'prior invoker binding'],
        ['an authenticated-user member', {
            iam: oldInvokerBinding([
                `serviceAccount:${OLD_IDENTITIES.preflight.task}`,
                'allAuthenticatedUsers',
            ]),
        }, 'prior invoker binding'],
        ['a conditioned binding', {
            iam: oldInvokerBinding(
                [
                    `serviceAccount:${OLD_IDENTITIES.preflight.task}`,
                    `serviceAccount:${PREFLIGHT_MAINTENANCE}`,
                ],
                { condition: { title: 'temporary', expression: 'true' } },
            ),
        }, 'prior invoker binding'],
        ['a missing prior caller member', {
            iam: oldInvokerBinding([`serviceAccount:${PREFLIGHT_MAINTENANCE}`]),
        }, 'prior invoker binding'],
        ['a missing maintenance member', {
            iam: oldInvokerBinding([`serviceAccount:${OLD_IDENTITIES.preflight.task}`]),
        }, 'prior invoker binding'],
        ['a caller that is already the desired identity', {
            iam: oldInvokerBinding([
                'serviceAccount:preflight-task@example-project.iam.gserviceaccount.com',
                `serviceAccount:${PREFLIGHT_MAINTENANCE}`,
            ]),
        }, 'prior invoker binding'],
        ['two invoker bindings', {
            iam: {
                bindings: [
                    { role: 'roles/run.invoker', members: [`serviceAccount:${OLD_IDENTITIES.preflight.task}`] },
                    { role: 'roles/run.invoker', members: [`serviceAccount:${PREFLIGHT_MAINTENANCE}`] },
                ],
            },
        }, 'prior invoker binding'],
        ['no invoker binding at all', {
            iam: {
                bindings: [
                    { role: 'roles/viewer', members: ['serviceAccount:unrelated@example-project.iam.gserviceaccount.com'] },
                ],
            },
        }, 'prior invoker binding'],
    ];

    it.each(oldInvokerIamCases)(
        'requires the exact reviewed prior invoker binding before reconciling IAM: %s',
        (_name, overrides, expected) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    // Correction 4: a suffix match accepts a same-named queue in another project
    // or region.  The observed queue must be the full resource identity.
    const targetQueueIdentityCases: Array<[string, FakeRunOptions, string]> = [
        ['same queue name in another project', {
            targetQueue: {
                name: 'projects/other-project/locations/asia-northeast3/queues/analysis-preflight',
            },
        }, 'requires the exact PAUSED target queue'],
        ['same queue name in another location', {
            targetQueue: {
                name: 'projects/example-project/locations/us-central1/queues/analysis-preflight',
            },
        }, 'requires the exact PAUSED target queue'],
        ['a queue name that merely ends with the target name', {
            targetQueue: {
                name: 'projects/example-project/locations/asia-northeast3/queues/shadow-analysis-preflight',
            },
        }, 'requires the exact PAUSED target queue'],
    ];

    it.each(targetQueueIdentityCases)(
        'requires the full target queue resource identity: %s',
        (_name, overrides, expected) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    // Correction 5: global distinctness covers all eight desired workload
    // identities of both roles, maintenance included.
    const eightIdentityDistinctnessCases: Array<[string, Record<string, string>, string]> = [
        ['paid maintenance aliases the preflight task caller', {
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL:
                'preflight-task@example-project.iam.gserviceaccount.com',
        }, 'task, enqueuer, runtime, and maintenance identities must be distinct'],
        ['paid maintenance aliases the preflight runtime', {
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL:
                'preflight-runtime@example-project.iam.gserviceaccount.com',
        }, 'task, enqueuer, runtime, and maintenance identities must be distinct'],
        ['paid maintenance aliases the preflight maintenance identity', {
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL: PREFLIGHT_MAINTENANCE,
        }, 'task, enqueuer, runtime, and maintenance identities must be distinct'],
        ['paid maintenance aliases the paid enqueuer', {
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL:
                'paid-enqueuer@example-project.iam.gserviceaccount.com',
        }, 'task, enqueuer, runtime, and maintenance identities must be distinct'],
        ['the other role maintenance identity is missing', {
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL: '',
        }, 'the other workload maintenance identity is required'],
        ['the other role maintenance identity is malformed', {
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL: 'not-a-service-account',
        }, 'invalid other workload maintenance service account'],
    ];

    it.each(eightIdentityDistinctnessCases)(
        'requires all eight desired workload identities to be distinct: %s',
        (_name, environment, expected) => {
            const result = fakeRun({ role: 'preflight', environment, args: ['--check'] });
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).toBe('');
        },
    );

    it('rejects a prior identity that aliases the other role maintenance identity', () => {
        const result = identityRollForwardRun('preflight', {
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL:
                    'paid-maintenance@example-project.iam.gserviceaccount.com',
            },
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`)
            .toContain('must differ from every desired workload identity');
        expect(result.calls).toBe('');
    });

    it('rejects a prior identity that aliases the build identity', () => {
        const result = identityRollForwardRun('preflight', {
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_RUNTIME_SERVICE_ACCOUNT_EMAIL:
                    'analysis-build@example-project.iam.gserviceaccount.com',
            },
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`)
            .toContain('must differ from every desired workload identity');
        expect(result.calls).toBe('');
    });

    // Correction 6: prior-state assertions are meaningful only under the
    // explicit exceptional flag.  Supplying one without the flag is an operator
    // error that must fail before anything is observed.
    const strayPriorAssertionCases: Array<[string, Record<string, string>]> = [
        ['prior task caller', {
            ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL:
                OLD_IDENTITIES.preflight.task,
        }],
        ['prior enqueuer', {
            ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_ENQUEUER_SERVICE_ACCOUNT_EMAIL: 'absent',
        }],
        ['prior runtime', {
            ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_RUNTIME_SERVICE_ACCOUNT_EMAIL:
                OLD_IDENTITIES.preflight.runtime,
        }],
        ['prior source SHA', {
            ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_SOURCE_SHA: OLD_IDENTITY_SOURCE_SHA,
        }],
    ];

    it.each(strayPriorAssertionCases)(
        'rejects a %s assertion supplied without the explicit exceptional flag',
        (_name, environment) => {
            for (const args of [['--check'], ['--apply', '--reconcile-iam']]) {
                const result = fakeRun({ role: 'preflight', environment, args });
                expect(result.status).not.toBe(0);
                expect(`${result.stdout}\n${result.stderr}`).toContain(
                    'initial identity roll-forward assertions require --allow-initial-identity-roll-forward',
                );
                expect(result.calls).toBe('');
            }
        },
    );

    const stagedIdentityExactnessCases: Array<['task' | 'enqueuer' | 'runtime', string]> = [
        ['task', 'Cloud Run observed task identity drifted'],
        ['enqueuer', 'Cloud Run observed environment drifted for PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL'],
        ['runtime', 'Cloud Run runtime service account drifted'],
    ];

    it.each(stagedIdentityExactnessCases)(
        'requires the staged revision to carry the exact rotated %s identity',
        (field, expected) => {
            const result = identityRollForwardRun('preflight', { deploySkipsIdentity: field });
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).toContain('run deploy');
            expect(result.calls).not.toContain('run services update-traffic');
        },
    );

    const postPromotionIdentityDriftCases: Array<[
        'task' | 'enqueuer' | 'runtime', string, string,
    ]> = [
        ['task', OLD_IDENTITIES.preflight.task, 'Cloud Run observed task identity drifted'],
        ['enqueuer', 'preflight-enqueuer-legacy@example-project.iam.gserviceaccount.com',
            'Cloud Run observed environment drifted for PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL'],
        ['runtime', OLD_IDENTITIES.preflight.runtime, 'Cloud Run runtime service account drifted'],
    ];

    it.each(postPromotionIdentityDriftCases)(
        'rolls back when post-promotion %s identity drifts after the rotated revision serves all traffic',
        (field, value, expected) => {
            const result = identityRollForwardRun('preflight', {
                postDeployIdentityDrift: { field, value },
            });
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls.match(/run services update-traffic/g) ?? []).toHaveLength(2);
            expect(`${result.stderr}`).toContain('rollback verified');
        },
    );

    // A genuine ordinary path: the serving revision really has drifted
    // identities, but the operator supplied no exceptional assertions at all.
    it('leaves the ordinary initial deploy path unchanged without the explicit allowance', () => {
        const result = fakeRun({
            role: 'preflight',
            observedSourceSha: OLD_IDENTITY_SOURCE_SHA,
            serviceEnv: { PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: OLD_IDENTITIES.preflight.task },
            serviceOverrides: {
                spec: { template: { spec: { serviceAccountName: OLD_IDENTITIES.preflight.runtime } } },
            },
            args: ['--apply', '--reconcile-iam'],
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('Cloud Run observed task identity drifted');
        expect(result.calls).not.toContain('run deploy');
        expect(result.calls).not.toContain('run services set-iam-policy');
    });

    // Correction B: an every-minute recovery scheduler that is still ENABLED can
    // enqueue an old-caller task after the queue was observed empty, so the
    // exceptional path needs an aged, externally asserted pause epoch plus the
    // exact PAUSED job resource.  An absent lastAttemptTime never proves drain.
    // These fixtures are relative to "now", so they are built lazily inside the
    // test body.  Computing them while the case table is collected would let
    // them age past the quiescence window during a long full-suite run and
    // silently stop testing the boundary they name.
    const schedulerQuiescenceCases: Array<[string, () => FakeRunOptions, string]> = [
        ['missing pause epoch assertion', () => ({
            environment: { ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH: '' },
        }), 'requires an exact preflight recovery scheduler pause epoch assertion'],
        ['malformed pause epoch assertion', () => ({
            environment: { ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH: '17e9' },
        }), 'pause epoch must be strict decimal epoch seconds'],
        ['zero-padded pause epoch assertion', () => ({
            environment: { ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH: '01700000000' },
        }), 'pause epoch must be strict decimal epoch seconds'],
        ['future pause epoch assertion', () => ({
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH:
                    String(Math.floor(Date.now() / 1000) + 3600),
            },
        }), 'pause epoch must not be in the future'],
        ['too recent pause epoch assertion', () => ({
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH: agedPauseEpoch(120),
            },
        }), 'recovery scheduler quiescence window'],
        ['pause epoch just inside the quiescence window', () => ({
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH:
                    agedPauseEpoch(PREFLIGHT_RECOVERY_QUIESCENCE_SECONDS - 60),
            },
        }), 'recovery scheduler quiescence window'],
    ];

    it.each(schedulerQuiescenceCases)(
        'rejects an unproven recovery scheduler pause: %s',
        (_name, makeOverrides, expected) => {
            const result = identityRollForwardRun('preflight', makeOverrides());
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    const schedulerStateCases: Array<[string, () => FakeRunOptions, string]> = [
        ['still ENABLED', () => ({ schedulerJob: { state: 'ENABLED' } }),
            'recovery scheduler must be observably PAUSED'],
        ['unobservable', () => ({ schedulerJob: 'unobservable' }),
            'recovery scheduler could not be observed'],
        ['wrong job resource', () => ({
            schedulerJob: {
                state: 'PAUSED',
                name: 'projects/other-project/locations/asia-northeast3/jobs/analysis-preflight-recovery',
            },
        }), 'recovery scheduler must be observably PAUSED'],
        ['drifted attempt deadline', () => ({
            schedulerJob: { state: 'PAUSED', attemptDeadline: '900s' },
        }), 'recovery scheduler must be observably PAUSED'],
        ['missing job resource name', () => ({
            schedulerJob: { state: 'PAUSED', name: null },
        }), 'recovery scheduler must be observably PAUSED'],
        ['wrong job location', () => ({
            schedulerJob: {
                state: 'PAUSED',
                name: 'projects/example-project/locations/us-central1/jobs/analysis-preflight-recovery',
            },
        }), 'recovery scheduler must be observably PAUSED'],
        ['wrong job name', () => ({
            schedulerJob: {
                state: 'PAUSED',
                name: 'projects/example-project/locations/asia-northeast3/jobs/some-other-job',
            },
        }), 'recovery scheduler must be observably PAUSED'],
        // Documented behaviour: a paused job can stop reporting lastAttemptTime
        // even seconds after a real attempt, so absence must never prove drain.
        ['absent lastAttemptTime with a too-recent asserted pause', () => ({
            schedulerJob: { state: 'PAUSED' },
            environment: {
                ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH: agedPauseEpoch(90),
            },
        }), 'recovery scheduler quiescence window'],
        ['recent lastAttemptTime despite an aged asserted pause', () => ({
            schedulerJob: {
                state: 'PAUSED',
                lastAttemptTime: new Date(Date.now() - 30_000).toISOString().replace(/\.\d+Z$/, 'Z'),
            },
        }), 'recovery scheduler last attempt is inside the quiescence window'],
        ['malformed lastAttemptTime', () => ({
            schedulerJob: { state: 'PAUSED', lastAttemptTime: 'not-a-timestamp' },
        }), 'recovery scheduler last attempt timestamp is malformed'],
    ];

    it.each(schedulerStateCases)(
        'rejects a recovery scheduler that is not provably quiescent: %s',
        (_name, makeOverrides, expected) => {
            const result = identityRollForwardRun('preflight', makeOverrides());
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    // The whole reviewed job contract is evidence, not just its state: a job
    // that is PAUSED but reconfigured could be resumed into a different,
    // unreviewed behaviour at any moment.
    const schedulerConfigDriftCases: Array<[string, Record<string, unknown>]> = [
        ['schedule', { schedule: '*/5 * * * *' }],
        ['time zone', { timeZone: 'Asia/Seoul' }],
        ['attempt deadline', { attemptDeadline: '600s' }],
        ['HTTP method', { httpTarget: { httpMethod: 'GET' } }],
        ['recover URI', { httpTarget: { uri: 'https://preflight.example.com/api/analysis/preflight/other' } }],
        ['recover URI origin', { httpTarget: { uri: 'https://elsewhere.example.com/api/analysis/preflight/recover' } }],
        ['Content-Type header', { httpTarget: { headers: { 'Content-Type': 'text/plain' } } }],
        ['base64 body', { httpTarget: { body: 'eyJhIjoxfQ==' } }],
        ['maintenance service account', {
            httpTarget: {
                oidcToken: {
                    serviceAccountEmail: 'preflight-maintenance-old@example-project.iam.gserviceaccount.com',
                    audience: 'https://preflight.example.com',
                },
            },
        }],
        ['OIDC audience', {
            httpTarget: {
                oidcToken: {
                    serviceAccountEmail: 'preflight-maintenance@example-project.iam.gserviceaccount.com',
                    audience: 'https://elsewhere.example.com',
                },
            },
        }],
        ['retry count', { retryConfig: { retryCount: 5 } }],
        ['max retry duration', { retryConfig: { maxRetryDuration: '900s' } }],
        ['min backoff duration', { retryConfig: { minBackoffDuration: '1s' } }],
        ['max backoff duration', { retryConfig: { maxBackoffDuration: '600s' } }],
        ['max doublings', { retryConfig: { maxDoublings: 9 } }],
    ];

    it.each(schedulerConfigDriftCases)(
        'rejects recovery scheduler configuration drift in %s',
        (_name, patch) => {
            const base = {
                schedule: '* * * * *',
                timeZone: 'Etc/UTC',
                attemptDeadline: '300s',
                httpTarget: {
                    uri: 'https://preflight.example.com/api/analysis/preflight/recover',
                    httpMethod: 'POST',
                    oidcToken: {
                        serviceAccountEmail: 'preflight-maintenance@example-project.iam.gserviceaccount.com',
                        audience: 'https://preflight.example.com',
                    },
                    headers: { 'Content-Type': 'application/json' },
                    body: 'e30=',
                },
                retryConfig: {
                    retryCount: 3,
                    maxRetryDuration: '300s',
                    minBackoffDuration: '10s',
                    maxBackoffDuration: '60s',
                    maxDoublings: 3,
                },
            };
            const result = identityRollForwardRun('preflight', {
                schedulerJob: { state: 'PAUSED', ...deepMerge(base, patch) },
            });
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`)
                .toContain('recovery scheduler must be observably PAUSED');
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    // Runs the script's own rfc3339_to_epoch against fixed timestamps, so the
    // rounding boundary is proven deterministically instead of racing the clock.
    function runRfc3339ToEpoch(value: string): { status: number; stdout: string } {
        const source = readFileSync(join(root, 'scripts/deploy-analysis-capacity-workers.sh'), 'utf8');
        const start = source.indexOf('rfc3339_to_epoch() {');
        expect(start, 'rfc3339_to_epoch must exist in the deploy script').toBeGreaterThanOrEqual(0);
        const end = source.indexOf('\n}\n', start);
        expect(end, 'rfc3339_to_epoch must be a closed shell function').toBeGreaterThan(start);
        const fn = source.slice(start, end + 3);
        const harnessDir = mkdtempSync(join(tmpdir(), 'rfc3339-'));
        const harnessPath = join(harnessDir, 'rfc3339.sh');
        writeFileSync(harnessPath, `#!/usr/bin/env bash\nset -euo pipefail\n${fn}\nrfc3339_to_epoch "$1"\n`);
        try {
            const result = spawnSync('bash', [harnessPath, value], {
                encoding: 'utf8',
                timeout: CHILD_PROCESS_TIMEOUT_MS,
            });
            return { status: result.status ?? -1, stdout: (result.stdout ?? '').trim() };
        } finally {
            rmSync(harnessDir, { recursive: true, force: true });
        }
    }

    it('rounds an attempt timestamp up so 659.999s never clears the 660s window', () => {
        // A fixed reference instant makes this exact rather than clock-dependent.
        const referenceEpoch = 1_800_000_000;
        const attemptMs = referenceEpoch * 1000 - 659_999;
        const attempt = new Date(attemptMs).toISOString();
        const observed = Number(runRfc3339ToEpoch(attempt).stdout);
        // Ceiling => 659s of apparent age, which is inside the window and is
        // refused. Flooring would have reported 660s and wrongly cleared it.
        expect(referenceEpoch - observed).toBe(659);
        expect(referenceEpoch - observed).toBeLessThan(PREFLIGHT_RECOVERY_QUIESCENCE_SECONDS);
        expect(referenceEpoch - Math.floor(attemptMs / 1000))
            .toBe(PREFLIGHT_RECOVERY_QUIESCENCE_SECONDS);
    });

    it.each([
        ['whole second', '2026-01-01T00:00:00.000Z', 1767225600],
        ['one millisecond past', '2026-01-01T00:00:00.001Z', 1767225601],
        ['999 milliseconds past', '2026-01-01T00:00:00.999Z', 1767225601],
        ['no fractional part', '2026-01-01T00:00:00Z', 1767225600],
        // Date.parse truncates below milliseconds, so sub-millisecond precision
        // must be honoured from the fractional string rather than the parse.
        ['one nanosecond past', '2026-01-01T00:00:00.000000001Z', 1767225601],
        ['all-zero nanoseconds', '2026-01-01T00:00:00.000000000Z', 1767225600],
        ['one microsecond past', '2026-01-01T00:00:00.000001Z', 1767225601],
        ['trailing nonzero at high precision', '2026-01-01T00:00:00.0000000000001Z', 1767225601],
    ])('parses a %s timestamp with ceiling semantics', (_name, value, expected) => {
        const result = runRfc3339ToEpoch(value);
        expect(result.status).toBe(0);
        expect(Number(result.stdout)).toBe(expected);
    });

    it.each([
        ['a local-time timestamp', '2026-01-01T00:00:00'],
        ['an offset timestamp', '2026-01-01T00:00:00+09:00'],
        ['a bare date', '2026-01-01'],
        ['prose', 'not-a-timestamp'],
        ['an empty value', ''],
    ])('fails closed on %s', (_name, value) => {
        expect(runRfc3339ToEpoch(value).status).not.toBe(0);
    });

    it('rejects a fractional lastAttemptTime that is inside the quiescence window', () => {
        const result = identityRollForwardRun('preflight', {
            schedulerJob: {
                state: 'PAUSED',
                lastAttemptTime: new Date(Date.now() - 600_500).toISOString(),
            },
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`)
            .toContain('recovery scheduler last attempt is inside the quiescence window');
        expect(result.calls).not.toContain('run services set-iam-policy');
        expect(result.calls).not.toContain('run deploy');
    });

    const capturedGenerationCases: Array<[string, FakeRunOptions, string]> = [
        ['missing', { serviceJsonPatch: 'del(.metadata.generation)' },
            'positive Cloud Run metadata.generation'],
        ['null', { serviceJsonPatch: '.metadata.generation = null' },
            'positive Cloud Run metadata.generation'],
        ['zero', { serviceOverrides: { metadata: { generation: 0 } } },
            'positive Cloud Run metadata.generation'],
        ['negative', { serviceOverrides: { metadata: { generation: -3 } } },
            'positive Cloud Run metadata.generation'],
        ['malformed', { serviceOverrides: { metadata: { generation: 'seven' } } },
            'positive Cloud Run metadata.generation'],
        ['fractional', { serviceOverrides: { metadata: { generation: 1.5 } } },
            'positive Cloud Run metadata.generation'],
    ];

    it.each(capturedGenerationCases)(
        'refuses to own a prior service whose metadata.generation is %s',
        (_name, overrides, expected) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    const capturedResourceVersionCases: Array<[string, FakeRunOptions]> = [
        ['missing', { serviceJsonPatch: 'del(.metadata.resourceVersion)' }],
        ['null', { serviceJsonPatch: '.metadata.resourceVersion = null' }],
        ['empty', { serviceOverrides: { metadata: { resourceVersion: '' } } }],
    ];

    it.each(capturedResourceVersionCases)(
        'refuses to own a prior service whose metadata.resourceVersion is %s',
        (_name, overrides) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`)
                .toContain('observable Cloud Run metadata.resourceVersion');
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    // The job name and the resolved location both reach gcloud as positional /
    // flag input, so they are validated before any scheduler command runs.
    const schedulerInputCases: Array<[string, Record<string, string>, string]> = [
        ['a job name with a shell metacharacter', {
            PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB: 'analysis-preflight-recovery; rm -rf /',
        }, 'recovery scheduler job name is invalid'],
        ['a job name with a flag prefix', {
            PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB: '--project=attacker-project',
        }, 'recovery scheduler job name is invalid'],
        ['a job name with a path separator', {
            PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB: 'projects/other/jobs/x',
        }, 'recovery scheduler job name is invalid'],
        ['an empty job name', {
            PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB: ' ',
        }, 'recovery scheduler job name is invalid'],
        ['a malformed maintenance location', {
            PREFLIGHT_TASKS_MAINTENANCE_LOCATION: 'not a region',
        }, 'recovery scheduler location is invalid'],
        ['a maintenance location with a flag prefix', {
            PREFLIGHT_TASKS_MAINTENANCE_LOCATION: '--format=json',
        }, 'recovery scheduler location is invalid'],
    ];

    it.each(schedulerInputCases)(
        'validates scheduler input before any gcloud call: %s',
        (_name, environment, expected) => {
            const result = identityRollForwardRun('preflight', { environment });
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('scheduler jobs');
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    // The maintenance contract may place the recovery job in its own location,
    // so the expected resource name must follow that resolved location.
    it('resolves the recovery scheduler location from the maintenance contract', () => {
        const result = identityRollForwardRun('preflight', {
            environment: { PREFLIGHT_TASKS_MAINTENANCE_LOCATION: 'us-central1' },
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`)
            .toContain('recovery scheduler must be observably PAUSED');
        expect(result.calls).toContain('scheduler jobs describe analysis-preflight-recovery');
        expect(result.calls).toContain('--location=us-central1');
        expect(result.calls).not.toContain('run services set-iam-policy');
        expect(result.calls).not.toContain('run deploy');
    });

    it('accepts an aged pause assertion with an aged lastAttemptTime', () => {
        const result = identityRollForwardRun('preflight', {
            schedulerJob: {
                state: 'PAUSED',
                lastAttemptTime: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z'),
            },
        });
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.stdout).toContain('recovery scheduler is the exact PAUSED job');
    });

    // Correction C: the exceptional run must never resume the recovery
    // scheduler; the external final rollout owns the sole resume.
    it('never resumes the recovery scheduler on a successful exceptional run', () => {
        const result = identityRollForwardRun('preflight');
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.calls).not.toContain('scheduler jobs resume');
        expect(result.calls).not.toContain('scheduler jobs update');
        expect(result.calls).not.toContain('scheduler jobs create');
        expect(result.calls).not.toContain('scheduler jobs pause');
        expect(result.finalScheduler.state).toBe('PAUSED');
        expect(result.stdout).toContain('resume deferred');
    });

    it.each([
        ['a failed queue precondition', { targetQueue: { state: 'RUNNING' } }],
        ['a failed staged revision', { deploySkipsIdentity: 'task' as const }],
        ['a failed post-promotion check', {
            postDeployIdentityDrift: { field: 'task' as const, value: OLD_IDENTITIES.preflight.task },
        }],
    ] as Array<[string, FakeRunOptions]>)(
        'leaves the recovery scheduler PAUSED after %s',
        (_name, overrides) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(result.calls).not.toContain('scheduler jobs resume');
            expect(result.finalScheduler.state).toBe('PAUSED');
        },
    );

    // Correction D/E: one dedicated final barrier immediately before the single
    // set-iam-policy re-proves every piece of evidence against the latest state.
    const finalBarrierCases: Array<[string, FakeRunOptions, string]> = [
        ['the service resourceVersion changed after validation', {
            serviceDriftAfterReads: { afterReads: 3, patch: '.metadata.resourceVersion = "rv-fixture-0002"' },
        }, 'service changed between verification and the identity mutation barrier'],
        ['the service generation changed after validation', {
            serviceDriftAfterReads: { afterReads: 3, patch: '.metadata.generation = 8' },
        }, 'service changed between verification and the identity mutation barrier'],
        ['the serving task identity became the desired identity after validation', {
            serviceDriftAfterReads: {
                afterReads: 3,
                patch: '(.spec.template.spec.containers[0].env) |= map(if .name == "PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL" then {name: .name, value: "preflight-task@example-project.iam.gserviceaccount.com"} else . end)',
            },
        }, 'service changed between verification and the identity mutation barrier'],
        ['the serving runtime identity changed after validation', {
            serviceDriftAfterReads: {
                afterReads: 3,
                patch: '.spec.template.spec.serviceAccountName = "preflight-runtime@example-project.iam.gserviceaccount.com"',
            },
        }, 'service changed between verification and the identity mutation barrier'],
        ['the source provenance moved to another valid old SHA after validation', {
            serviceDriftAfterReads: {
                afterReads: 3,
                patch: '.metadata.labels["analysis-v2-source-commit"] = "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"',
            },
        }, 'service changed between verification and the identity mutation barrier'],
        ['the invoker binding became the desired binding between reads', {
            iamDriftAfterReads: {
                afterReads: 2,
                patch: '(.bindings) |= map(if .role == "roles/run.invoker" then {role: .role, members: ["serviceAccount:preflight-task@example-project.iam.gserviceaccount.com", "serviceAccount:preflight-maintenance@example-project.iam.gserviceaccount.com"]} else . end)',
            },
        }, 'prior invoker binding'],
        ['an extra invoker member appeared between reads', {
            iamDriftAfterReads: {
                afterReads: 2,
                patch: '(.bindings) |= map(if .role == "roles/run.invoker" then (.members += ["serviceAccount:intruder@example-project.iam.gserviceaccount.com"]) else . end)',
            },
        }, 'prior invoker binding'],
        ['a condition appeared on the invoker binding between reads', {
            iamDriftAfterReads: {
                afterReads: 2,
                patch: '(.bindings) |= map(if .role == "roles/run.invoker" then (.condition = {title: "t", expression: "true"}) else . end)',
            },
        }, 'prior invoker binding'],
        ['the latest policy has no etag', {
            iamDriftAfterReads: { afterReads: 2, patch: 'del(.etag)' },
        }, 'non-empty etag'],
        ['the latest policy has an empty etag', {
            iamDriftAfterReads: { afterReads: 2, patch: '.etag = ""' },
        }, 'non-empty etag'],
    ];

    it.each(finalBarrierCases)(
        'fails closed at the final mutation barrier when %s',
        (_name, overrides, expected) => {
            const result = identityRollForwardRun('preflight', overrides);
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run services set-iam-policy');
            expect(result.calls).not.toContain('run deploy');
        },
    );

    const iamPostconditionCases: Array<[string, string, string]> = [
        ['an unrelated binding was altered',
            '(.bindings) |= map(if .role == "roles/viewer" then {role: .role, members: ["serviceAccount:someone-else@example-project.iam.gserviceaccount.com"]} else . end)',
            'observed IAM policy does not match the policy this run intended'],
        ['an unexpected binding was added',
            '.bindings += [{role: "roles/run.admin", members: ["serviceAccount:intruder@example-project.iam.gserviceaccount.com"]}]',
            'observed IAM policy does not match the policy this run intended'],
        ['an unexpected member was added to the invoker binding',
            '(.bindings) |= map(if .role == "roles/run.invoker" then (.members += ["allUsers"]) else . end)',
            'observed IAM policy does not match the policy this run intended'],
        ['a condition was introduced on the invoker binding',
            '(.bindings) |= map(if .role == "roles/run.invoker" then (.condition = {title: "t", expression: "true"}) else . end)',
            'observed IAM policy does not match the policy this run intended'],
        ['the policy version was changed',
            '.version = 3',
            'observed IAM policy does not match the policy this run intended'],
    ];

    it.each(iamPostconditionCases)(
        'rejects a post-write IAM policy where %s',
        (_name, patch, expected) => {
            const result = identityRollForwardRun('preflight', { postSetIamPatch: patch });
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).not.toContain('run deploy');
            expect(result.calls.match(/run services set-iam-policy/g) ?? []).toHaveLength(1);
        },
    );

    it('writes the rotated invoker policy exactly once, preserving the latest etag', () => {
        const result = identityRollForwardRun('preflight');
        expect(result.status, `${result.stderr?.toString() ?? ''}\n${result.calls}`).toBe(0);
        expect(result.calls.match(/run services set-iam-policy/g) ?? []).toHaveLength(1);
        // The policy actually handed to set-iam-policy must carry the etag from
        // the latest pre-mutation read, which is what fences a concurrent edit.
        expect(result.sentIamPolicy).not.toBeNull();
        expect(result.sentIamPolicy?.etag).toBe('BwXfixture01=');
        expect((result.sentIamPolicy?.bindings as Array<{ role: string; members: string[] }>)
            .find((binding) => binding.role === 'roles/run.invoker')?.members).toEqual([
            'serviceAccount:preflight-maintenance@example-project.iam.gserviceaccount.com',
            'serviceAccount:preflight-task@example-project.iam.gserviceaccount.com',
        ]);
        const bindings = result.finalIam.bindings as Array<{ role: string; members: string[] }>;
        expect(bindings.find((binding) => binding.role === 'roles/run.invoker')?.members).toEqual([
            'serviceAccount:preflight-maintenance@example-project.iam.gserviceaccount.com',
            'serviceAccount:preflight-task@example-project.iam.gserviceaccount.com',
        ]);
        // Unrelated bindings and the policy version survive the rotation.
        expect(bindings.find((binding) => binding.role === 'roles/viewer')?.members).toEqual([
            'serviceAccount:unrelated@example-project.iam.gserviceaccount.com',
        ]);
        expect(result.finalIam.version).toBe(1);
    });

    // A rejected write must not be retried: racing a concurrent policy update is
    // exactly what the etag fence exists to prevent.
    it('never retries a rejected invoker write and leaves the queue and scheduler paused', () => {
        const result = identityRollForwardRun('preflight', { failSetIamPolicy: true });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('no retry is attempted');
        expect(result.calls.match(/run services set-iam-policy/g) ?? []).toHaveLength(1);
        expect(result.calls).not.toContain('run deploy');
        expect(result.calls).not.toContain('run services update-traffic');
        expect(result.calls).not.toContain('scheduler jobs resume');
        expect(result.finalScheduler.state).toBe('PAUSED');
    });

    it('is rejected by the server when the presented etag is not the latest', () => {
        // The policy is built from the read that happens before the barrier's
        // own re-read; drifting the etag in between must fail the write.
        const result = identityRollForwardRun('preflight', {
            iamDriftAfterReads: { afterReads: 3, patch: '.etag = "BwXsomeoneElse="' },
        });
        expect(result.status).not.toBe(0);
        expect(result.calls.match(/run services set-iam-policy/g) ?? []).toHaveLength(1);
        expect(result.calls).not.toContain('run deploy');
        expect(result.finalScheduler.state).toBe('PAUSED');
    });

    // Correction G: the other-role tuple is trusted by global distinctness, so
    // it must be validated with the same rules as the active role.
    const otherRoleIdentityCases: Array<[string, Record<string, string>, string]> = [
        ['malformed other task identity', {
            ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: 'not-a-service-account',
        }, 'invalid other workload task service account'],
        ['malformed other enqueuer identity', {
            ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL: 'nope@example.com',
        }, 'invalid other workload enqueuer service account'],
        ['malformed other runtime identity', {
            ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL: 'bad',
        }, 'invalid other workload runtime service account'],
        ['cross-project other task identity', {
            ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: 'paid-task@other-project.iam.gserviceaccount.com',
        }, 'other workload task service account must belong to the other workload project'],
        ['cross-project other runtime identity', {
            ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL: 'paid-runtime@other-project.iam.gserviceaccount.com',
        }, 'other workload runtime service account must belong to the other workload project'],
        ['cross-project other maintenance identity', {
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL: 'paid-maintenance@other-project.iam.gserviceaccount.com',
        }, 'other workload maintenance service account must belong to the other workload project'],
        ['other maintenance aliases the build identity', {
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL: 'analysis-build@example-project.iam.gserviceaccount.com',
        }, 'build service account must be distinct from every desired workload identity'],
        ['build identity aliases the active task caller', {
            ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT: 'preflight-task@example-project.iam.gserviceaccount.com',
        }, 'build service account must be distinct from every desired workload identity'],
        ['build identity aliases the other role runtime', {
            ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT: 'paid-runtime@example-project.iam.gserviceaccount.com',
        }, 'build service account must be distinct from every desired workload identity'],
    ];

    it.each(otherRoleIdentityCases)(
        'validates the other-role identities before trusting global distinctness: %s',
        (_name, environment, expected) => {
            const result = fakeRun({ role: 'preflight', environment, args: ['--check'] });
            expect(result.status).not.toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
            expect(result.calls).toBe('');
        },
    );
});
