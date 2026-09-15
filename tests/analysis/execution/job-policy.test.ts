import { describe, expect, it } from "vitest";
import { requireCompletedInteractionJob, requireNoIncompleteInteractionJobs } from "../../../lib/services/analysis/interaction-job-state";
import { ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION, analysisV2WorkerTaskContractFromHeader } from "../../../lib/services/analysis/v2-worker-task-contract";
import { ANALYSIS_V2_EXECUTION_CAPABILITY, isAnalysisV2AdmissionAvailable, isAnalysisV2RecoveryAvailable, isAnalysisV2WorkerAvailable, isPreflightRecoveryAvailable } from "../../../lib/services/analysis/v2-execution-gate";
import { hasValidAnalysisRequestIdempotencyKey } from "../../../lib/services/analysis/request-eligibility";
import { MAX_PUBLIC_PROFILES_PER_ANALYSIS, capPublicProfiles, getRelationshipScrapeLimit } from "../../../lib/services/analysis/plan-limits";
import { legacyAnalysisProducerGate } from "../../../lib/services/analysis/legacy-analysis-gate";
import { getLegacyRunAccess } from "../../../lib/services/analysis/legacy-run-access";
import { ANALYSIS_V2_BOOTSTRAP_JOB_KEY, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY, analysisV2JobInputHash, isAnalysisV2CoordinatorJob, planAnalysisV2Successors } from "../../../lib/services/analysis/v2-coordinator";

describe("interaction-job-state", () => {
    describe('interaction job state guards', () => {
        const completed = {
            kind: 'target_likers',
            batch_index: 0,
            status: 'completed' as const,
        };

        it('accepts only the requested completed job', () => {
            expect(() => requireCompletedInteractionJob(
                [completed],
                'target_likers',
                0
            )).not.toThrow();
            expect(() => requireCompletedInteractionJob(
                [{ ...completed, status: 'failed' }],
                'target_likers',
                0
            )).toThrow('INTERACTION_PROVIDER_ERROR');
            expect(() => requireCompletedInteractionJob(
                [{ ...completed, status: 'running' }],
                'target_likers',
                0
            )).toThrow('INTERACTION_PROVIDER_ERROR');
            expect(() => requireCompletedInteractionJob(
                [completed],
                'target_comments',
                0
            )).toThrow('INTERACTION_PROVIDER_ERROR');
        });

        it('refuses scoring while any persisted job is failed or running', () => {
            expect(() => requireNoIncompleteInteractionJobs([completed])).not.toThrow();
            expect(() => requireNoIncompleteInteractionJobs([
                completed,
                { ...completed, status: 'failed' },
            ])).toThrow('INTERACTION_PROVIDER_ERROR');
            expect(() => requireNoIncompleteInteractionJobs([
                { ...completed, status: 'running' },
            ])).toThrow('INTERACTION_PROVIDER_ERROR');
        });
    });
});

describe("v2-worker-task-contract", () => {
    describe('analysis V2 worker task timing contract', () => {
        it('keeps versionless queued tasks on their original bounded execution contract', () => {
            expect(analysisV2WorkerTaskContractFromHeader(null)).toEqual({
                dispatchDeadlineSeconds: 300,
                handlerWindowMs: 300_000,
                jobLeaseSeconds: 360,
            });
        });

        it('uses the extended contract only for newly-enqueued v2 tasks', () => {
            expect(analysisV2WorkerTaskContractFromHeader(
                String(ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION),
            )).toEqual({
                dispatchDeadlineSeconds: 600,
                handlerWindowMs: 540_000,
                jobLeaseSeconds: 600,
            });
        });

        it('fails safe to the legacy contract for an absent or unknown header', () => {
            expect(analysisV2WorkerTaskContractFromHeader(undefined)).toEqual(
                analysisV2WorkerTaskContractFromHeader('3'),
            );
        });
    });
});

describe("v2-execution-gate", () => {
    describe('analysis V2 split execution gates', () => {
        it('ships the jobs capability behind three explicit independent flags', () => {
            expect(ANALYSIS_V2_EXECUTION_CAPABILITY).toBe('jobs');
            const env = {
                ANALYSIS_V2_ADMISSION_ENABLED: 'false',
                ANALYSIS_V2_WORKER_ENABLED: 'true',
                ANALYSIS_V2_RECOVERY_ENABLED: 'true',
            };
            expect(isAnalysisV2AdmissionAvailable(env)).toBe(false);
            expect(isAnalysisV2WorkerAvailable(env)).toBe(true);
            expect(isAnalysisV2RecoveryAvailable(env)).toBe(true);
        });

        it.each([
            [isAnalysisV2AdmissionAvailable, 'ANALYSIS_V2_ADMISSION_ENABLED'],
            [isAnalysisV2WorkerAvailable, 'ANALYSIS_V2_WORKER_ENABLED'],
            [isAnalysisV2RecoveryAvailable, 'ANALYSIS_V2_RECOVERY_ENABLED'],
        ] as const)('fails closed and rejects ambiguous %s values', (gate, key) => {
            expect(gate({})).toBe(false);
            expect(gate({ [key]: 'off' })).toBe(false);
            expect(gate({ [key]: 'on' })).toBe(true);
            expect(() => gate({ [key]: 'enabled' })).toThrow(`${key} must be boolean.`);
        });

        it('keeps preflight recovery behind its own strict gate', () => {
            expect(isPreflightRecoveryAvailable({})).toBe(false);
            expect(isPreflightRecoveryAvailable({ PREFLIGHT_TASKS_RECOVERY_ENABLED: 'false' })).toBe(false);
            expect(isPreflightRecoveryAvailable({ PREFLIGHT_TASKS_RECOVERY_ENABLED: 'true' })).toBe(true);
            expect(() => isPreflightRecoveryAvailable({
                PREFLIGHT_TASKS_RECOVERY_ENABLED: 'maybe',
            })).toThrow('PREFLIGHT_TASKS_RECOVERY_ENABLED must be boolean.');
        });
    });
});

describe("request-eligibility", () => {
    describe('analysis request paid-step eligibility', () => {
        it('accepts only requests carrying the server start contract key', () => {
            expect(hasValidAnalysisRequestIdempotencyKey({
                idempotency_key: 'analysis-key-0000000000000000',
            })).toBe(true);
            expect(hasValidAnalysisRequestIdempotencyKey({ idempotency_key: null })).toBe(false);
            expect(hasValidAnalysisRequestIdempotencyKey({})).toBe(false);
            expect(hasValidAnalysisRequestIdempotencyKey({ idempotency_key: 'short' })).toBe(false);
        });
    });
});

describe("plan-limits", () => {
    describe('analysis plan collection limits', () => {
        it('maps Basic and Standard to their relationship caps', () => {
            expect(getRelationshipScrapeLimit('basic')).toBe(500);
            expect(getRelationshipScrapeLimit('standard')).toBe(1_000);
            expect(getRelationshipScrapeLimit(undefined)).toBe(500);
            expect(getRelationshipScrapeLimit('unknown')).toBe(500);
        });

        it('caps only the downstream public profile analysis stage', () => {
            const profiles = Array.from({ length: 400 }, (_, index) => index);
            expect(capPublicProfiles(profiles)).toHaveLength(MAX_PUBLIC_PROFILES_PER_ANALYSIS);
            expect(profiles).toHaveLength(400);
        });
    });
});

describe("legacy-analysis-gate", () => {
    describe('legacy analysis producer gate', () => {
        it('keeps the pre-rollout and bootstrap contracts open', () => {
            expect(legacyAnalysisProducerGate({})).toBe('open');
            expect(legacyAnalysisProducerGate({ ANALYSIS_CAPACITY_STAGE: 'bootstrap' })).toBe('open');
        });

        it('freezes V1 producers only on the exact active drain contract', () => {
            expect(legacyAnalysisProducerGate({
                ANALYSIS_CAPACITY_STAGE: 'initial',
                ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
                ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            })).toBe('frozen');
            expect(legacyAnalysisProducerGate({
                ANALYSIS_CAPACITY_STAGE: 'expanded',
                ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
                ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'TRUE',
            })).toBe('frozen');
        });

        it('fails closed for an active stage without authoritative freeze evidence', () => {
            expect(legacyAnalysisProducerGate({ ANALYSIS_CAPACITY_STAGE: 'initial' })).toBe('misconfigured');
            expect(legacyAnalysisProducerGate({
                ANALYSIS_CAPACITY_STAGE: 'initial',
                ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
                ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'false',
            })).toBe('misconfigured');
        });
    });
});

describe("legacy-run-access", () => {
    describe('legacy analysis run access', () => {
        it('is disabled by default even for an admin bearer token', () => {
            expect(getLegacyRunAccess('Bearer secret', { ADMIN_API_KEY: 'secret' }))
                .toBe('disabled');
        });

        it('requires both the explicit switch and exact admin authorization', () => {
            const env = {
                ENABLE_LEGACY_ANALYSIS_RUN: 'true',
                ADMIN_API_KEY: 'secret',
            };
            expect(getLegacyRunAccess(null, env)).toBe('forbidden');
            expect(getLegacyRunAccess('Bearer wrong', env)).toBe('forbidden');
            expect(getLegacyRunAccess('Bearer secret', env)).toBe('allowed');
        });
    });
});

describe("v2-coordinator", () => {
    const requestId = '123e4567-e89b-42d3-a456-426614174000';

    describe('analysis V2 coordinator foundation', () => {
        it('fans bootstrap into the two independent evidence tracks', () => {
            const jobs = planAnalysisV2Successors(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY);
            expect(jobs.map(job => job.jobKey)).toEqual([
                ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
                ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
            ]);
            expect(jobs.every(job => job.requiredJobKeys.length === 0)).toBe(true);
            expect(jobs.every(job => /^[a-f0-9]{64}$/.test(job.inputHash))).toBe(true);
        });

        it('gives both predecessors the same dependency-gated join candidate', () => {
            const fromRelationships = planAnalysisV2Successors(
                requestId,
                ANALYSIS_V2_RELATIONSHIPS_JOB_KEY
            );
            const fromTargetEvidence = planAnalysisV2Successors(
                requestId,
                ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY
            );
            expect(fromRelationships).toEqual(fromTargetEvidence);
            expect(fromRelationships[0]).toMatchObject({
                jobKey: ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
                requiredJobKeys: [
                    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
                    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
                ],
            });
        });

        it('does not invent later-phase work after the foundation join', () => {
            expect(planAnalysisV2Successors(requestId, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY))
                .toEqual([]);
        });

        it('derives stable PII-free hashes and validates coordinator keys', () => {
            expect(analysisV2JobInputHash(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY))
                .toBe(analysisV2JobInputHash(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY));
            expect(() => analysisV2JobInputHash('not-a-uuid', ANALYSIS_V2_BOOTSTRAP_JOB_KEY))
                .toThrow('invalid request id');
            expect(isAnalysisV2CoordinatorJob(ANALYSIS_V2_BOOTSTRAP_JOB_KEY)).toBe(true);
            expect(isAnalysisV2CoordinatorJob(ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY)).toBe(true);
            expect(isAnalysisV2CoordinatorJob(ANALYSIS_V2_RELATIONSHIPS_JOB_KEY)).toBe(false);
        });
    });
});
