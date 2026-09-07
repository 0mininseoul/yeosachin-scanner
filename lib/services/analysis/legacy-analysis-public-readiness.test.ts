import { describe, expect, it } from 'vitest';
import {
    getLegacyAnalysisPublicReadiness,
    PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
    PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
} from './legacy-analysis-public-readiness';

const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const expectedPreflightFingerprint = '6ab53812cdc725c34bf3409713a893ec7787482e17df16ef622f3173a57251f2';
const expectedPaidFingerprint = 'd074cb79af9df1622cfff38f981e1f7ea0e892390c442d4504d6c77c9b398c1f';

const validEnvironment = {
    ANALYSIS_CAPACITY_STAGE: 'initial',
    ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
    ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
    ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
    ANALYSIS_CAPACITY_SOURCE_SHA: sourceSha,
    VERCEL_GIT_COMMIT_SHA: sourceSha,
    ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
    PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
    PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/preflight/worker',
    PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
    ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: 'PAID-TASK@example-project.iam.gserviceaccount.com',
    ANALYSIS_V2_TASKS_TARGET_URL: 'https://Paid.Example.com:443/api/analysis/v2/worker',
    ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://PAID.example.com:443/',
    EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'false',
};

describe('public freeze readiness observation', () => {
    it('reports non-sensitive active freeze evidence from the public runtime', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            ANALYSIS_CAPACITY_SOURCE_SHA: sourceSha,
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
            PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/preflight/worker',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
            ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: 'PAID-TASK@example-project.iam.gserviceaccount.com',
            ANALYSIS_V2_TASKS_TARGET_URL: 'https://Paid.Example.com:443/api/analysis/v2/worker',
            ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://PAID.example.com:443/',
        });
        expect(result.ready).toBe(true);
        expect(result.schemaVersion).toBe('analysis-public-freeze-readiness-v3');
        expect(result.sourceSha).toBe(sourceSha);
        expect(result.preflightProducerConfigFingerprintVersion)
            .toBe(PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION);
        expect(result.preflightProducerConfigFingerprint).toBe(expectedPreflightFingerprint);
        expect(result.preflightProducerConfigReady).toBe(true);
        expect(result.paidProducerConfigFingerprintVersion).toBe(PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION);
        expect(result.paidProducerConfigFingerprint).toBe(expectedPaidFingerprint);
        expect(result.paidProducerConfigReady).toBe(true);
        expect(result.analysisV2AdmissionEnabled).toBe(false);
        expect(result.earlybirdWebhookAutoAdmissionEnabled).toBe(false);
        expect(JSON.stringify(result)).not.toContain('PAID-TASK@example-project');
        expect(JSON.stringify(result)).not.toContain('Paid.Example.com');
        expect(JSON.stringify(result)).not.toContain('PAID.example.com');
        expect(result.routes['/api/analysis/start']).toEqual({
            gateState: 'frozen',
            expectedStatus: 410,
            gateBeforeRuntime: true,
        });
        expect(Object.keys(result)).toEqual([
            'schemaVersion', 'ready', 'stage', 'freezeMode',
            'publicFreezeEnabled', 'sourceSha', 'legacyTargetResource',
            'preflightProducerConfigFingerprintVersion',
            'preflightProducerConfigFingerprint', 'preflightProducerConfigReady',
            'paidProducerConfigFingerprintVersion',
            'paidProducerConfigFingerprint', 'paidProducerConfigReady', 'routes',
            'analysisV2AdmissionEnabled', 'earlybirdWebhookAutoAdmissionEnabled',
        ]);
    });

    it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
    ] as const)('preserves v2 ready and routes for every independent admission pair (%s, %s)',
        (publicGate, paidGate) => {
            const result = getLegacyAnalysisPublicReadiness({
                ...validEnvironment,
                ANALYSIS_V2_ADMISSION_ENABLED: String(publicGate),
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: String(paidGate),
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: '2026-01-01T00:00:00Z',
            });
            expect(result.ready).toBe(true);
            expect(result.analysisV2AdmissionEnabled).toBe(publicGate);
            expect(result.earlybirdWebhookAutoAdmissionEnabled).toBe(paidGate);
            expect(Object.keys(result).slice(-2)).toEqual([
                'analysisV2AdmissionEnabled', 'earlybirdWebhookAutoAdmissionEnabled',
            ]);
        });

    it('fails closed on malformed independent admission configuration', () => {
        expect(() => getLegacyAnalysisPublicReadiness({
            ...validEnvironment,
            ANALYSIS_V2_ADMISSION_ENABLED: 'maybe',
        })).toThrow('ANALYSIS_V2_ADMISSION_ENABLED');
        expect(() => getLegacyAnalysisPublicReadiness({
            ...validEnvironment,
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'true',
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: 'not-a-date',
        })).toThrow('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE_INVALID');
    });

    it.each([
        ['stage', { ANALYSIS_CAPACITY_STAGE: 'unknown' }],
        ['freeze mode', { ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'open' }],
        ['public freeze', { ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'false' }],
        ['legacy producer gate', { ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'false' }],
        ['source provenance', { VERCEL_GIT_COMMIT_SHA: 'not-a-sha' }],
        ['preflight producer', { PREFLIGHT_TASKS_TARGET_URL: 'https://wrong.example.com/worker' }],
        ['paid producer', { ANALYSIS_V2_TASKS_TARGET_URL: 'https://wrong.example.com/worker' }],
    ] as const)('keeps aggregate ready false when v2 %s is missing for every independent gate pair',
        (_name, override) => {
            for (const publicGate of [false, true]) {
                for (const paidGate of [false, true]) {
                    const result = getLegacyAnalysisPublicReadiness({
                        ...validEnvironment,
                        ...override,
                        ANALYSIS_V2_ADMISSION_ENABLED: String(publicGate),
                        EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: String(paidGate),
                        EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: '2026-01-01T00:00:00Z',
                    });
                    expect(result.ready).toBe(false);
                    expect(result.analysisV2AdmissionEnabled).toBe(publicGate);
                    expect(result.earlybirdWebhookAutoAdmissionEnabled).toBe(paidGate);
                }
            }
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
        expect(result.preflightProducerConfigFingerprint).toBeNull();
        expect(result.preflightProducerConfigReady).toBe(false);
        expect(result.paidProducerConfigFingerprint).toBeNull();
        expect(result.paidProducerConfigReady).toBe(false);
        expect(Object.values(result.routes).every((route) => route.expectedStatus === 410)).toBe(true);
    });

    it('fails closed when the active paid producer tuple is missing or malformed', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
            PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/preflight/worker',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
            ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: 'paid-task@example-project.iam.gserviceaccount.com',
            ANALYSIS_V2_TASKS_TARGET_URL: 'https://paid.example.com/api/analysis/not-worker',
            ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://paid.example.com',
        });
        expect(result.ready).toBe(false);
        expect(result.paidProducerConfigFingerprint).toBeNull();
        expect(result.paidProducerConfigReady).toBe(false);
    });

    it.each([
        ['target userinfo', 'https://user:secret@paid.example.com/api/analysis/v2/worker', 'https://paid.example.com'],
        ['target query', 'https://paid.example.com/api/analysis/v2/worker?probe=1', 'https://paid.example.com'],
        ['target hash', 'https://paid.example.com/api/analysis/v2/worker#probe', 'https://paid.example.com'],
        ['target wrong path', 'https://paid.example.com/api/analysis/not-worker', 'https://paid.example.com'],
        ['audience query', 'https://paid.example.com/api/analysis/v2/worker', 'https://paid.example.com?probe=1'],
        ['audience hash', 'https://paid.example.com/api/analysis/v2/worker', 'https://paid.example.com#probe'],
        ['audience path', 'https://paid.example.com/api/analysis/v2/worker', 'https://paid.example.com/audience'],
        ['audience origin', 'https://paid.example.com/api/analysis/v2/worker', 'https://other.example.com'],
    ] as const)('fails closed when the paid producer has %s', (_name, target, audience) => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            ANALYSIS_CAPACITY_SOURCE_SHA: sourceSha,
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
            PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/preflight/worker',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
            ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: 'paid-task@example-project.iam.gserviceaccount.com',
            ANALYSIS_V2_TASKS_TARGET_URL: target,
            ANALYSIS_V2_TASKS_OIDC_AUDIENCE: audience,
        });
        expect(result.ready).toBe(false);
        expect(result.paidProducerConfigFingerprint).toBeNull();
        expect(result.paidProducerConfigReady).toBe(false);
    });

    it('fails closed when the active producer target or audience is invalid', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
            PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/not-worker',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
        });
        expect(result.ready).toBe(false);
        expect(result.preflightProducerConfigFingerprint).toBeNull();
        expect(result.preflightProducerConfigReady).toBe(false);
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
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
            PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/preflight/worker',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
        });
        expect(result.ready).toBe(false);
        expect(result.sourceSha).toBeNull();
    });
});
