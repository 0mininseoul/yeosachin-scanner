import { createHash } from 'node:crypto';
import { legacyAnalysisProducerGate } from './legacy-analysis-gate';

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SERVICE_ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const PREFLIGHT_TARGET_PATH = '/api/analysis/preflight/worker';
const PAID_TARGET_PATH = '/api/analysis/v2/worker';
const PUBLIC_READINESS_SCHEMA_VERSION = 'analysis-public-freeze-readiness-v2' as const;

export const PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION = 'preflight-producer-config-v1' as const;
export const PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION = 'paid-producer-config-v1' as const;

export const LEGACY_PUBLIC_READINESS_ROUTES = Object.freeze([
    '/api/analysis/start',
    '/api/analysis/step',
    '/api/analysis/run',
] as const);

export type LegacyPublicReadiness = {
    schemaVersion: typeof PUBLIC_READINESS_SCHEMA_VERSION;
    ready: boolean;
    stage: 'initial' | 'expanded' | 'unknown';
    freezeMode: 'drain-and-block' | 'unknown';
    publicFreezeEnabled: boolean;
    sourceSha: string | null;
    legacyTargetResource: string | null;
    preflightProducerConfigFingerprintVersion: typeof PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION;
    preflightProducerConfigFingerprint: string | null;
    preflightProducerConfigReady: boolean;
    paidProducerConfigFingerprintVersion: typeof PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION;
    paidProducerConfigFingerprint: string | null;
    paidProducerConfigReady: boolean;
    routes: Record<(typeof LEGACY_PUBLIC_READINESS_ROUTES)[number], {
        gateState: 'frozen' | 'not_ready';
        expectedStatus: 410 | 503;
        gateBeforeRuntime: true;
    }>;
};

type ProducerConfig = {
    serviceAccountEmail: string;
    targetUrl: string;
    audience: string;
};

function normalizeProducerConfig(
    env: Record<string, string | undefined>,
    serviceAccountEnvName: string,
    targetEnvName: string,
    audienceEnvName: string,
    targetPath: string,
): ProducerConfig | null {
    const serviceAccountEmail = env[serviceAccountEnvName]?.trim().toLowerCase() || '';
    if (!SERVICE_ACCOUNT_PATTERN.test(serviceAccountEmail)) return null;

    const targetValue = env[targetEnvName]?.trim() || '';
    const audienceValue = env[audienceEnvName]?.trim() || '';
    let target: URL;
    let audience: URL;
    try {
        target = new URL(targetValue);
        audience = new URL(audienceValue);
    } catch {
        return null;
    }
    if (target.protocol !== 'https:'
        || target.username
        || target.password
        || target.search
        || target.hash
        || !/^[A-Za-z0-9.-]+$/.test(target.hostname)
        || target.pathname !== targetPath
        || audience.protocol !== 'https:'
        || audience.username
        || audience.password
        || audience.search
        || audience.hash
        || !/^[A-Za-z0-9.-]+$/.test(audience.hostname)
        || (audience.pathname !== '' && audience.pathname !== '/')) {
        return null;
    }
    const targetUrl = `${target.origin}${targetPath}`;
    const normalizedAudience = audience.origin;
    if (target.origin !== normalizedAudience) return null;
    return {
        serviceAccountEmail,
        targetUrl,
        audience: normalizedAudience,
    };
}

function producerConfigFingerprint(
    config: ProducerConfig,
    version: string,
): string {
    return createHash('sha256').update([
        version,
        config.serviceAccountEmail,
        config.targetUrl,
        config.audience,
    ].join('\n'), 'utf8').digest('hex');
}

function normalizePreflightProducerConfig(
    env: Record<string, string | undefined>,
): ProducerConfig | null {
    return normalizeProducerConfig(
        env,
        'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL',
        'PREFLIGHT_TASKS_TARGET_URL',
        'PREFLIGHT_TASKS_OIDC_AUDIENCE',
        PREFLIGHT_TARGET_PATH,
    );
}

function normalizePaidProducerConfig(
    env: Record<string, string | undefined>,
): ProducerConfig | null {
    return normalizeProducerConfig(
        env,
        'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL',
        'ANALYSIS_V2_TASKS_TARGET_URL',
        'ANALYSIS_V2_TASKS_OIDC_AUDIENCE',
        PAID_TARGET_PATH,
    );
}

/**
 * Read-only, PII-free evidence served by the public Next/Vercel runtime.
 * This endpoint is deliberately separate from the private worker manifest:
 * it evaluates the same gate in the process that owns the public V1 routes.
 */
export function getLegacyAnalysisPublicReadiness(
    env: Record<string, string | undefined> = process.env,
): LegacyPublicReadiness {
    const stageValue = env.ANALYSIS_CAPACITY_STAGE?.trim().toLowerCase();
    const stage: LegacyPublicReadiness['stage'] = stageValue === 'initial' || stageValue === 'expanded'
        ? stageValue
        : 'unknown';
    const freezeModeValue = env.ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE?.trim().toLowerCase();
    const freezeMode: LegacyPublicReadiness['freezeMode'] = freezeModeValue === 'drain-and-block'
        ? freezeModeValue
        : 'unknown';
    const publicFreezeEnabled = env.ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED
        ?.trim()
        .toLowerCase() === 'true';
    const vercelSourceSha = env.VERCEL_GIT_COMMIT_SHA?.trim() || '';
    const configuredSourceSha = env.ANALYSIS_CAPACITY_SOURCE_SHA?.trim() || '';
    const sourceSha = SOURCE_SHA_PATTERN.test(vercelSourceSha)
        && (!configuredSourceSha || configuredSourceSha === vercelSourceSha)
        ? vercelSourceSha
        : null;
    const legacyTargetResource = env.ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE?.trim() || null;
    const preflightProducerConfig = normalizePreflightProducerConfig(env);
    const preflightProducerConfigFingerprintValue = preflightProducerConfig
        ? producerConfigFingerprint(
            preflightProducerConfig,
            PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        )
        : null;
    const preflightProducerConfigReady = preflightProducerConfigFingerprintValue !== null;
    const paidProducerConfig = normalizePaidProducerConfig(env);
    const paidProducerConfigFingerprintValue = paidProducerConfig
        ? producerConfigFingerprint(paidProducerConfig, PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION)
        : null;
    const paidProducerConfigReady = paidProducerConfigFingerprintValue !== null;
    const frozen = legacyAnalysisProducerGate(env) === 'frozen';
    const routeStatus: 410 | 503 = frozen ? 410 : 503;
    const routes = Object.fromEntries(
        LEGACY_PUBLIC_READINESS_ROUTES.map((route) => [route, {
            gateState: frozen ? 'frozen' : 'not_ready',
            expectedStatus: routeStatus,
            gateBeforeRuntime: true,
        }]),
    ) as LegacyPublicReadiness['routes'];

    return {
        schemaVersion: PUBLIC_READINESS_SCHEMA_VERSION,
        ready: stage !== 'unknown'
            && freezeMode === 'drain-and-block'
            && publicFreezeEnabled
            && frozen
            && sourceSha !== null
            && preflightProducerConfigReady
            && paidProducerConfigReady,
        stage,
        freezeMode,
        publicFreezeEnabled,
        sourceSha,
        legacyTargetResource,
        preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        preflightProducerConfigFingerprint: preflightProducerConfigFingerprintValue,
        preflightProducerConfigReady,
        paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        paidProducerConfigFingerprint: paidProducerConfigFingerprintValue,
        paidProducerConfigReady,
        routes,
    };
}
