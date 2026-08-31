import { legacyAnalysisProducerGate } from './legacy-analysis-gate';

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const LEGACY_PUBLIC_READINESS_ROUTES = Object.freeze([
    '/api/analysis/start',
    '/api/analysis/step',
    '/api/analysis/run',
] as const);

export type LegacyPublicReadiness = {
    schemaVersion: 'analysis-public-freeze-readiness-v1';
    ready: boolean;
    stage: 'initial' | 'expanded' | 'unknown';
    freezeMode: 'drain-and-block' | 'unknown';
    publicFreezeEnabled: boolean;
    sourceSha: string | null;
    legacyTargetResource: string | null;
    routes: Record<(typeof LEGACY_PUBLIC_READINESS_ROUTES)[number], {
        gateState: 'frozen' | 'not_ready';
        expectedStatus: 410 | 503;
        gateBeforeRuntime: true;
    }>;
};

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
        schemaVersion: 'analysis-public-freeze-readiness-v1',
        ready: stage !== 'unknown'
            && freezeMode === 'drain-and-block'
            && publicFreezeEnabled
            && frozen
            && sourceSha !== null,
        stage,
        freezeMode,
        publicFreezeEnabled,
        sourceSha,
        legacyTargetResource,
        routes,
    };
}
