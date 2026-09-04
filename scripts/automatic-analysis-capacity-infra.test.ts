import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const KNOWN_PREFLIGHT_OLD_SOURCE_SHA = '3b28e55c8877276557f8a5a218fb2b966376d889';
// Every child command in this contract suite is deliberately bounded.  The
// suite exercises shell wrappers, so an accidentally waiting fake command must
// fail the test deterministically instead of leaving Vitest's worker RPC
// pending behind a synchronous child process.
const CHILD_PROCESS_TIMEOUT_MS = 30_000;

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
    const lockPath = join(fixtureDir, 'deploy.lock');
    const manifestPath = join(fixtureDir, 'runtime.json');
    const logPath = join(fixtureDir, 'calls.log');
    const fakeGcloud = join(binDir, 'gcloud');
    const fakeCurl = join(binDir, 'curl');
    // This fake has no network access and mutates only fixture files when a
    // set-iam-policy command is explicitly exercised by --apply.
    writeFileSync(servicePath, JSON.stringify(serviceJson));
    writeFileSync(iamPath, JSON.stringify(iamJson));
    writeFileSync(legacyQueuePath, JSON.stringify({
        name: 'projects/example-project/locations/asia-northeast3/queues/analysis-pipeline',
        state: 'PAUSED',
    }));
    writeFileSync(legacyTasksPath, JSON.stringify([]));
    writeFileSync(publicFreezePath, JSON.stringify({
        schemaVersion: 'analysis-public-freeze-readiness-v1',
        ready: active,
        stage,
        freezeMode: active ? 'drain-and-block' : 'unknown',
        publicFreezeEnabled: active,
        sourceSha: active ? sourceCommit : null,
        legacyTargetResource: 'vercel:production:analysis-v1',
        routes: Object.fromEntries([
            '/api/analysis/start', '/api/analysis/step', '/api/analysis/run',
        ].map((route) => [route, {
            gateState: active ? 'frozen' : 'not_ready',
            expectedStatus: active ? 410 : 503,
            gateBeforeRuntime: true,
        }])),
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
    writeFileSync(schedulerPath, JSON.stringify({
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
    writeFileSync(manifestPath, JSON.stringify(manifestFor(role, {
        ANALYSIS_CAPACITY_STAGE: stage,
        ANALYSIS_CAPACITY_EXPANSION_CANARY: expansionCanary,
        ...options.manifestOverrides,
    }, options.environment)));
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
if [[ "\${1:-} \${2:-} \${3:-}" == "tasks queues describe" ]]; then cat "$FAKE_GCLOUD_LEGACY_QUEUE_JSON"; exit 0; fi
if [[ "\${1:-} \${2:-}" == "tasks list" ]]; then cat "$FAKE_GCLOUD_LEGACY_TASKS_JSON"; exit 0; fi
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
if [[ "\${1:-} \${2:-} \${3:-}" == "run services describe" ]]; then cat "$FAKE_GCLOUD_SERVICE_JSON"; exit 0; fi
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
if [[ "\${1:-} \${2:-} \${3:-}" == "run services get-iam-policy" ]]; then cat "$FAKE_GCLOUD_IAM_JSON"; exit 0; fi
if [[ "\${1:-} \${2:-}" == "run deploy" ]]; then
  jq --arg rev "$FAKE_GCLOUD_NEXT_REVISION" --arg stage "$FAKE_GCLOUD_TARGET_STAGE" --arg active "$FAKE_GCLOUD_ACTIVE" --arg role "$FAKE_GCLOUD_ROLE" --arg source "$FAKE_GCLOUD_SOURCE_SHA" --arg stagedTraffic "$FAKE_GCLOUD_STAGED_TRAFFIC" --argjson desiredSecretEnv "$FAKE_GCLOUD_DEPLOY_SECRET_ENV" '
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
  ' "$FAKE_GCLOUD_SERVICE_JSON" > "$FAKE_GCLOUD_SERVICE_JSON.tmp"
  mv "$FAKE_GCLOUD_SERVICE_JSON.tmp" "$FAKE_GCLOUD_SERVICE_JSON"
  exit 0
fi
if [[ "\${1:-} \${2:-} \${3:-}" == "run services set-iam-policy" ]]; then cp "\${5:-}" "$FAKE_GCLOUD_IAM_JSON"; exit 0; fi
if [[ "\${1:-} \${2:-} \${3:-}" == "run services update-traffic" ]]; then
  revision='';
  for argument in "\$@"; do
    case "\$argument" in --to-revisions=*) revision="\${argument#--to-revisions=}"; revision="\${revision%%=*}" ;; esac
  done
  jq --arg rev "\$revision" --arg postDeploySourceSha "\$FAKE_GCLOUD_POST_DEPLOY_SOURCE_SHA" '
    .status.traffic=[{revisionName:$rev,percent:100}]
    | .status.latestReadyRevisionName=$rev
    | if $postDeploySourceSha == "" then . else
        .metadata.labels["analysis-v2-source-commit"]=$postDeploySourceSha
        | .spec.template.metadata.labels["analysis-v2-source-commit"]=$postDeploySourceSha
      end
  ' "$FAKE_GCLOUD_SERVICE_JSON" > "$FAKE_GCLOUD_SERVICE_JSON.tmp"
  mv "$FAKE_GCLOUD_SERVICE_JSON.tmp" "$FAKE_GCLOUD_SERVICE_JSON"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "scheduler jobs" && "\${3:-}" == "describe" ]]; then cat "$FAKE_GCLOUD_SCHEDULER_JSON"; exit 0; fi
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
    chmodSync(fakeGcloud, 0o755);
    chmodSync(fakeCurl, 0o755);
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
            // a fake command. The built-in timeout sends SIGTERM to the child;
            // no unbounded wait or process-group assumption is needed here.
            timeout: 15_000,
            killSignal: 'SIGTERM',
        });
        const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
        const calls = readFileSync(logPath, 'utf8');
        if (timedOut) {
            throw new Error([
                'fake gcloud command exceeded the 15000ms child-process deadline',
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
        const finalScheduler = JSON.parse(readFileSync(schedulerPath, 'utf8')) as Record<string, unknown>;
        const finalService = JSON.parse(readFileSync(servicePath, 'utf8')) as Record<string, unknown>;
        return { ...result, calls, finalIam, finalScheduler, finalService };
    } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
    }
}

describe('automatic-analysis infrastructure contracts', () => {
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
        }, 'Cloud Run required Secret Manager ref drifted for APIFY_TERTIARY_API_TOKEN'],
    ] as const)('rejects non-exact preflight Secret Manager roll-forward: %s', (_name, options, expected) => {
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
});
