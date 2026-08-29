import { describe, expect, it, vi } from 'vitest';
import { isAnalysisV2WorkerErrorCode } from './v2-worker-error-codes';
import { classifyAnalysisV2JobFailure } from './v2-worker';
import {
    APIFY_DURABLE_PROVIDER_CALLBACK_ERROR_CODES,
} from '@/lib/services/instagram/providers/apify-relationship';
import { AnalysisV2AiResultRecoveryPendingError } from './v2-ai-result-store';
import { OPERATIONAL_ERROR_CODES } from '@/lib/observability/schema';

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
