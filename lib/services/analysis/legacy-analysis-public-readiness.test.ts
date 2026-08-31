import { describe, expect, it } from 'vitest';
import { getLegacyAnalysisPublicReadiness } from './legacy-analysis-public-readiness';

const sourceSha = '0123456789abcdef0123456789abcdef01234567';

describe('public V1 freeze readiness observation', () => {
    it('reports non-sensitive active freeze evidence from the public runtime', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            ANALYSIS_CAPACITY_SOURCE_SHA: sourceSha,
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
        });
        expect(result.ready).toBe(true);
        expect(result.sourceSha).toBe(sourceSha);
        expect(result.routes['/api/analysis/start']).toEqual({
            gateState: 'frozen',
            expectedStatus: 410,
            gateBeforeRuntime: true,
        });
        expect(Object.keys(result)).toEqual([
            'schemaVersion', 'ready', 'stage', 'freezeMode',
            'publicFreezeEnabled', 'sourceSha', 'legacyTargetResource', 'routes',
        ]);
    });

    it('fails closed when public freeze config or provenance is absent', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
        });
        expect(result.ready).toBe(false);
        expect(result.publicFreezeEnabled).toBe(false);
        expect(result.sourceSha).toBe(sourceSha);
        expect(Object.values(result.routes).every((route) => route.expectedStatus === 410)).toBe(true);
    });

    it('does not treat bootstrap as active public freeze evidence', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'bootstrap',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'false',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'bootstrap',
            ANALYSIS_CAPACITY_SOURCE_SHA: sourceSha,
            VERCEL_GIT_COMMIT_SHA: sourceSha,
        });
        expect(result.ready).toBe(false);
        expect(result.routes['/api/analysis/run'].gateBeforeRuntime).toBe(true);
    });

    it('rejects conflicting manual provenance instead of overriding Vercel provenance', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            ANALYSIS_CAPACITY_SOURCE_SHA: sourceSha.replace(/0/g, 'f'),
            VERCEL_GIT_COMMIT_SHA: sourceSha,
        });
        expect(result.ready).toBe(false);
        expect(result.sourceSha).toBeNull();
    });
});
