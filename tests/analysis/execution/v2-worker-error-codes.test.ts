import { describe, expect, it, vi } from 'vitest';
import { isAnalysisV2WorkerErrorCode } from '../../../lib/services/analysis/v2-worker-error-codes';
import { classifyAnalysisV2JobFailure } from '../../../lib/services/analysis/v2-worker';
import {
    APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES,
} from '@/lib/services/instagram/providers/apify-relationship';
import { AnalysisV2AiResultRecoveryPendingError } from '../../../lib/services/analysis/v2-ai-result-store';
import { OPERATIONAL_ERROR_CODES } from '@/lib/observability/schema';
import { createResultImageRegistry } from '@/lib/services/media/result-image-registry';
import { createClient } from '@supabase/supabase-js';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const PROVIDER_LIFECYCLE_PERSISTENCE_CODES = [
    'ANALYSIS_V2_PROVIDER_RUN_RESERVATION_PERSISTENCE_ERROR',
    'ANALYSIS_V2_PROVIDER_RUN_COST_START_PERSISTENCE_ERROR',
    'ANALYSIS_V2_PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR',
    'ANALYSIS_V2_PROVIDER_RUN_REJECTION_PERSISTENCE_ERROR',
] as const;

const PROFILE_AI_RUNTIME_CODES = [
    'ANALYSIS_V2_AI_AUDIT_CONTEXT_INVALID',
    'ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED',
    'ANALYSIS_V2_GENDER_RESOLUTION_CUTOFF_PERSISTENCE_ERROR',
    'ANALYSIS_V2_GENDER_RESOLUTION_EVIDENCE_DRIFT',
    'ANALYSIS_V2_GENDER_TRIAGE_MICROBATCH_DUPLICATE_ACCOUNT',
    'ANALYSIS_V2_GENDER_TRIAGE_MICROBATCH_EVIDENCE_DRIFT',
    'ANALYSIS_V2_GENDER_TRIAGE_MICROBATCH_MEDIA_LIMIT',
    'ANALYSIS_V2_GENDER_TRIAGE_MICROBATCH_POLICY_MISMATCH',
    'ANALYSIS_V2_GENDER_TRIAGE_MICROBATCH_RESULT_MISSING',
    'ANALYSIS_V2_GENDER_TRIAGE_MICROBATCH_SCHEDULER_REQUIRED',
    'ANALYSIS_V2_SCHEDULER_INVALID_POLICY',
    'ANALYSIS_V2_SCHEDULER_INVALID_TOPOLOGY',
    'ANALYSIS_V2_SCHEDULER_NOT_ENABLED',
    'ANALYSIS_V2_SCHEDULER_OPERATION_FENCE_MISMATCH',
    'ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR',
    'ANALYSIS_V2_SCHEDULER_OPERATION_STAGE_DRIFT',
    'ANALYSIS_V2_SCHEDULER_OPERATION_VALIDATION_ERROR',
    'ANALYSIS_V2_SCHEDULER_RECOVERY_HANDLER_MISSING',
    'ANALYSIS_V2_SCHEDULER_TERMINAL_HANDLER_MISSING',
    'ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_CONFIG_ERROR',
    'ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_CONFLICT',
    'ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR',
    'ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_VALIDATION_ERROR',
] as const;

describe('analysis V2 worker error codes', () => {
    it.each([
        [{ error: { code: 'P0001', message: 'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY' } },
            'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY', 'transient'],
        [{ error: { code: 'P0001', message: 'ANALYSIS_V2_RESULT_IMAGE_FENCE_MISMATCH' } },
            'ANALYSIS_V2_RESULT_IMAGE_FENCE_MISMATCH', 'fence'],
        [{ error: { code: 'P0001', message: 'ANALYSIS_V2_RESULT_IMAGE_CONFLICT' } },
            'ANALYSIS_V2_RESULT_IMAGE_CONFLICT', 'permanent'],
        [{ error: { code: 'P0001', message: 'ANALYSIS_V2_RESULT_IMAGE_INVALID' } },
            'ANALYSIS_V2_RESULT_IMAGE_INVALID', 'permanent'],
        [{ error: { code: '57014', message: 'canceling statement due to statement timeout' } },
            'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR', 'transient'],
        [{ error: { code: '40P01', message: 'deadlock detected' } },
            'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR', 'transient'],
        [{ error: { code: '55P03', message: 'canceling statement due to lock timeout' } },
            'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR', 'transient'],
        [{ error: { code: '', message: 'TypeError: fetch failed' }, status: 0 },
            'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR', 'transient'],
        [new TypeError('fetch failed'), 'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR', 'transient'],
        [{ error: { message: 'upstream detail' }, status: 503 },
            'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR', 'transient'],
        [{ error: { code: '', message: 'SyntaxError: malformed response' }, status: 0 },
            'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR', 'transient'],
        [{ error: { code: '23514', message: 'constraint with private values' } },
            'RESULT_IMAGE_REGISTRY_OPERATION_FAILED', 'permanent'],
        [{ error: { code: 'P0001', message: 'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY: private details' } },
            'RESULT_IMAGE_REGISTRY_OPERATION_FAILED', 'permanent'],
        [{ error: null }, 'RESULT_IMAGE_REGISTRY_INVALID_RESPONSE', 'permanent'],
    ] as const)('classifies and redacts registry RPC failure %#', async (response, code, disposition) => {
        const registry = createResultImageRegistry({
            async rpc() {
                if (response instanceof Error) throw response;
                return { ...response, data: null };
            },
        });
        const failure = await registry.sealManifest({
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            jobKey: 'coordinator:finalize',
            claimToken: '223e4567-e89b-42d3-a456-426614174000',
            jobInputHash: 'a'.repeat(64),
            orderedManifestHash: 'b'.repeat(64),
        }).catch(error => error);

        expect(failure).toMatchObject({ message: code });
        expect(classifyAnalysisV2JobFailure(failure)).toMatchObject({
            code,
            disposition,
            retryable: disposition === 'transient',
        });
    });

    it.each([
        ['{"sealed":', 'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR', 'transient'],
        ['{"unexpected":true}', 'RESULT_IMAGE_REGISTRY_INVALID_RESPONSE', 'permanent'],
    ])('distinguishes an incomplete HTTP receipt from an invalid decoded receipt %#', async (body, code, disposition) => {
        const client = createClient('https://synthetic.invalid', 'synthetic', {
            global: { fetch: async () => new Response(body, { status: 200 }) },
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const failure = await createResultImageRegistry(client).sealManifest({
            requestId: '123e4567-e89b-42d3-a456-426614174000',
            jobKey: 'coordinator:finalize',
            claimToken: '223e4567-e89b-42d3-a456-426614174000',
            jobInputHash: 'a'.repeat(64),
            orderedManifestHash: 'b'.repeat(64),
        }).catch(error => error);
        expect(classifyAnalysisV2JobFailure(failure)).toMatchObject({ code, disposition });
    });

    it.each([
        ['ANALYSIS_V2_RESULT_IMAGE_SOURCE_NOT_READY', 'transient'],
        ['RESULT_IMAGE_REGISTRY_INVALID_INPUT', 'permanent'],
        ['RESULT_IMAGE_CAPTURE_SOURCE_DRIFT', 'permanent'],
        ['ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT', 'permanent'],
        ['ANALYSIS_V2_PROFILE_GENDER_PLAN_PERSISTENCE_ERROR', 'transient'],
    ])('preserves the worker receipt and retry behavior for %s', (code, disposition) => {
        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({ code, disposition });
    });

    it('keeps progress fail-open codes telemetry-only', () => {
        for (const code of [
            'ANALYSIS_V2_PROGRESS_HEARTBEAT_FAIL_OPEN',
            'ANALYSIS_V2_PROGRESS_INITIALIZE_FAIL_OPEN',
            'ANALYSIS_V2_PROGRESS_REPORT_FAIL_OPEN',
        ]) {
            expect(OPERATIONAL_ERROR_CODES).toContain(code);
            expect(isAnalysisV2WorkerErrorCode(code)).toBe(false);
            expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
                code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
                disposition: 'permanent',
                retryable: false,
            });
        }
    });

    it('accepts every immutable Apify provider callback code', () => {
        expect(Array.isArray(APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES)).toBe(true);
        expect(Object.isFrozen(APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES)).toBe(true);
        for (const code of APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES) {
            expect(isAnalysisV2WorkerErrorCode(code), code).toBe(true);
        }
    });

    it.each(['DEV_LIVE_BUDGET_EXCEEDED', 'DEV_LIVE_BUDGET_UNAVAILABLE'])(
        'keeps the Dev budget refusal %s permanent with its exact receipt code',
        code => {
            expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
                code, disposition: 'permanent', retryable: false,
            });
        },
    );

    it.each(PROVIDER_LIFECYCLE_PERSISTENCE_CODES)(
        'allows the provider lifecycle phase code %s',
        (code) => {
            expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
        }
    );

    it.each(PROFILE_AI_RUNTIME_CODES)(
        'preserves the profile AI runtime code %s instead of collapsing it',
        (code) => {
            expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
            expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
                code,
            });
        }
    );

    it.each([
        ['ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR: retained upload failed (403).',
            'permanent', false],
        ['ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR: retained upload failed (408).',
            'transient', true],
        ['ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR: retained upload failed (429).',
            'transient', true],
        ['ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR: retained upload failed (500).',
            'transient', true],
        ['ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR: retained upload failed (503).',
            'transient', true],
        ['ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR: retained upload failed (599).',
            'transient', true],
        ['ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR: retained upload failed (unknown).',
            'transient', true],
        ['ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR: retained upload failed (409).',
            'permanent', false],
    ] as const)(
        'classifies the retained media failure %s as %s',
        (message, disposition, retryable) => {
            expect(classifyAnalysisV2JobFailure(new Error(message))).toMatchObject({
                code: 'ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR',
                disposition,
                retryable,
            });
        }
    );

    it.each(PROVIDER_LIFECYCLE_PERSISTENCE_CODES)(
        'classifies the provider lifecycle phase code %s as transient',
        (code) => {
            expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
                code,
                disposition: 'transient',
                retryable: true,
            });
        }
    );

    it('preserves an authorized test credential-policy mismatch as permanent', () => {
        const code = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH';
        expect(APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES).toContain(code);
        expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
            code,
            disposition: 'permanent',
            retryable: false,
        });
    });

    it('classifies a definite provider start rejection as permanent', () => {
        const code = 'SCRAPING_PROVIDER_START_REJECTED_ERROR';
        expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
            code,
            disposition: 'permanent',
            retryable: false,
        });
    });

    it.each([
        ['ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH', 'permanent', false],
        ['ANALYSIS_V2_AI_STAGE_POLICY_VALIDATION_ERROR', 'permanent', false],
        ['ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR', 'transient', true],
    ] as const)('classifies the AI policy fence code %s', (code, disposition, retryable) => {
        expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
            code,
            disposition,
            retryable,
        });
    });

    it.each([
        'ANALYSIS_V2_AI_CAPACITY_PENDING',
        'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
        'ANALYSIS_V2_AI_QUARANTINE_ACTIVE',
        'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING',
    ])('classifies the nonterminal admission code %s as transient', code => {
        expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
            code,
            disposition: 'transient',
            retryable: true,
        });
    });

    it('preserves the resolver recovery-pending executor error as transient', () => {
        const error = new AnalysisV2AiResultRecoveryPendingError();
        expect(classifyAnalysisV2JobFailure(error)).toMatchObject({
            code: 'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING',
            disposition: 'transient',
            retryable: true,
        });
    });

    it.each([
        'ANALYSIS_V2_COLLECTION_CONTEXT_INVALID_RESULT',
        'ANALYSIS_V2_COLLECTION_CONTEXT_RPC_PERSISTENCE_ERROR',
    ] as const)('retries the structural collection-context failure %s', code => {
        const error = new Error(code);

        expect(classifyAnalysisV2JobFailure(error)).toMatchObject({
            code,
            disposition: 'transient',
            retryable: true,
        });
    });

    it('keeps a collection-context snapshot drift permanent', () => {
        const code = 'ANALYSIS_V2_COLLECTION_CONTEXT_SNAPSHOT_DRIFT';

        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
            code,
            disposition: 'permanent',
            retryable: false,
        });
    });

    it('keeps a collection-context validation failure permanent', () => {
        const code = 'ANALYSIS_V2_COLLECTION_CONTEXT_VALIDATION_ERROR';

        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
            code,
            disposition: 'permanent',
            retryable: false,
        });
    });

    it('recognizes a divergent profile repair replay as a permanent conflict', () => {
        const code = 'ANALYSIS_V2_PROFILE_REPAIR_CONFLICT';
        expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
            code,
            disposition: 'permanent',
            retryable: false,
        });
    });

    it('recognizes a fresh-Apify profile checkpoint conflict as a permanent conflict', () => {
        const code = 'ANALYSIS_V2_PROFILE_FRESH_APIFY_CONFLICT';
        expect(isAnalysisV2WorkerErrorCode(code)).toBe(true);
        expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
            code,
            disposition: 'permanent',
            retryable: false,
        });
    });
});
