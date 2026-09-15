import { describe, expect, it } from "vitest";
import { CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING, isRetryablePipelineError, MAX_CLOUD_TASK_PIPELINE_RETRIES, shouldAbortPipelineBeforeExecution, shouldRetryPipelineError, trustedCloudTasksRetryCount } from "../../../lib/services/analysis/pipeline-retry";
import { ANALYSIS_LEASE_RETRY_DELAY_MS, ANALYSIS_PROGRESS_STEPS, ANALYSIS_STEP_RECOVERY_DELAY_MS, decideAnalysisStepFailure, shouldClientDriveAnalysis } from "../../../lib/services/analysis/progress-retry";
import { calculateLegacyV23FinalScores } from "../../../lib/services/analysis/v2-legacy-risk-recovery";

describe("pipeline-retry", () => {
    describe('analysis pipeline retry policy', () => {
        it('trusts the Cloud Tasks retry header only after task OIDC verification', () => {
            const headers = new Headers({ 'X-CloudTasks-TaskRetryCount': '2' });

            expect(trustedCloudTasksRetryCount(headers, true)).toBe(2);
            expect(trustedCloudTasksRetryCount(headers, false)).toBeNull();
            expect(trustedCloudTasksRetryCount(new Headers(), true)).toBeNull();
            expect(trustedCloudTasksRetryCount(
                new Headers({ 'X-CloudTasks-TaskRetryCount': '-1' }),
                true
            )).toBeNull();
        });

        it('retries only failures classified as transient', () => {
            expect(isRetryablePipelineError(
                new Error('SCRAPING_TIMEOUT_ERROR: provider timeout')
            )).toBe(true);
            expect(isRetryablePipelineError(
                new Error('ANALYSIS_PERSISTENCE_ERROR: temporary database outage')
            )).toBe(true);
            expect(isRetryablePipelineError(
                new Error('AI_ANALYSIS_UNAVAILABLE: model response could have been charged')
            )).toBe(false);
            expect(isRetryablePipelineError(
                new Error('AI_RESULT_PERSISTENCE_ERROR: generated result was not checkpointed')
            )).toBe(false);
            expect(isRetryablePipelineError(
                new Error('SCRAPING_CONFIG_ERROR: invalid credentials')
            )).toBe(false);
            expect(isRetryablePipelineError(
                new Error('SCRAPING_BUDGET_ERROR: operation cap reached')
            )).toBe(false);
            expect(isRetryablePipelineError(
                new Error('SCRAPING_PAID_REQUEST_AMBIGUOUS_ERROR: response status unknown')
            )).toBe(false);
            expect(isRetryablePipelineError(
                new Error('SCRAPING_PAID_REQUEST_ERROR: paid provider rejected the request')
            )).toBe(false);
            expect(isRetryablePipelineError(new Error('private account'))).toBe(false);
        });

        it('allows three Cloud Tasks retries and then exhausts the request', () => {
            const error = new Error('SCRAPING_ERROR: temporary provider outage');

            expect(shouldRetryPipelineError(error, 0)).toBe(true);
            expect(shouldRetryPipelineError(error, 2)).toBe(true);
            expect(shouldRetryPipelineError(
                error,
                MAX_CLOUD_TASK_PIPELINE_RETRIES
            )).toBe(false);
            expect(shouldRetryPipelineError(error, null)).toBe(false);
        });

        it('stops paid execution before the queue exhausts its delivery attempts', () => {
            expect(shouldAbortPipelineBeforeExecution(
                CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING - 1
            )).toBe(false);
            expect(shouldAbortPipelineBeforeExecution(
                CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING
            )).toBe(true);
            expect(shouldAbortPipelineBeforeExecution(null)).toBe(false);
            expect(() => shouldAbortPipelineBeforeExecution(0, 0))
                .toThrow('ANALYSIS_RETRY_ERROR');
        });
    });
});

describe("progress-retry", () => {
    describe('analysis progress retry decisions', () => {
        it('waits through repeated lease contention without consuming transient retries', () => {
            let retryCount = 0;
            for (let attempt = 0; attempt < 5; attempt++) {
                const decision = decideAnalysisStepFailure(409, false, retryCount);
                expect(decision).toEqual({
                    kind: 'lease_wait',
                    delayMs: ANALYSIS_LEASE_RETRY_DELAY_MS,
                    nextRetryCount: 0,
                });
                retryCount = decision.kind === 'lease_wait' ? decision.nextRetryCount : retryCount;
            }
        });

        it('stops on authorization/not-found responses and persisted pipeline failures', () => {
            expect(decideAnalysisStepFailure(401, false, 0)).toEqual({ kind: 'terminal' });
            expect(decideAnalysisStepFailure(403, false, 0)).toEqual({ kind: 'terminal' });
            expect(decideAnalysisStepFailure(404, false, 0)).toEqual({ kind: 'terminal' });
            expect(decideAnalysisStepFailure(500, true, 0))
                .toEqual({ kind: 'persisted_failure' });
        });

        it('bounds transient failures to 2s, 4s, and 8s retries', () => {
            expect(ANALYSIS_STEP_RECOVERY_DELAY_MS).toBe(30_000);
            expect(decideAnalysisStepFailure(504, false, 0)).toEqual({
                kind: 'transient_retry', delayMs: 2_000, nextRetryCount: 1,
            });
            expect(decideAnalysisStepFailure(504, false, 1)).toEqual({
                kind: 'transient_retry', delayMs: 4_000, nextRetryCount: 2,
            });
            expect(decideAnalysisStepFailure(504, false, 2)).toEqual({
                kind: 'transient_retry', delayMs: 8_000, nextRetryCount: 3,
            });
            expect(decideAnalysisStepFailure(504, false, 3)).toEqual({ kind: 'exhausted' });
        });

        it('keeps progress labels unique and aligned to persisted stage boundaries', () => {
            expect(ANALYSIS_PROGRESS_STEPS.map(step => step.threshold))
                .toEqual([25, 30, 50, 82, 92, 97, 100]);
            expect(new Set(ANALYSIS_PROGRESS_STEPS.map(step => step.label)).size)
                .toBe(ANALYSIS_PROGRESS_STEPS.length);
        });

        it('never drives paid steps from the browser once background mode is active', () => {
            expect(shouldClientDriveAnalysis('pending', false)).toBe(true);
            expect(shouldClientDriveAnalysis('processing', undefined)).toBe(true);
            expect(shouldClientDriveAnalysis('pending', true)).toBe(false);
            expect(shouldClientDriveAnalysis('processing', true)).toBe(false);
            expect(shouldClientDriveAnalysis('completed', false)).toBe(false);
            expect(shouldClientDriveAnalysis('failed', false)).toBe(false);
        });
    });
});

describe("v2-legacy-risk-recovery", () => {
    describe('v2.3 legacy recovery scorer', () => {
        it('preserves the origin/main v2.3 directionless weights and three-point replay bound', () => {
            const [candidate] = calculateLegacyV23FinalScores({
                preliminary: [{
                    candidateId: 'legacy:one', username: 'legacy.one',
                    appearanceGrade: 4, exposureScore: 2, accountContext: 'personal',
                    hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false,
                    uniqueTargetPostsLikedByCandidate: 4, boundedCandidateCommentsOnTarget: 12,
                    hasTagOrCaptionMention: true, recentFemaleMutualRank: 1,
                    recentMutualBadgeRank: 1, preScore: 0, verificationShortlistRank: 1,
                }],
                observedReverseLikeCandidateIds: new Set(),
                notCollectedCandidateIds: new Set(['legacy:one']),
            });
            expect(candidate?.risk.policyVersion).toBe('risk-policy-v2.3');
            expect(candidate?.risk.components).toEqual({
                candidateToTargetLikes: 20,
                candidateToTargetComments: 26,
                targetToCandidateLike: 0,
                tagOrCaptionMention: 14,
                recentMutual: 17,
                appearanceExposure: 13.333333333333334,
            });
            expect(candidate?.risk.preScore).toBe(90.33333333333333);
            expect(candidate?.risk.possibleUpperBound).toBe(93.33333333333333);
        });

        it('retains v2.3 reverse=3 and caution featured limit=15', () => {
            const preliminary = Array.from({ length: 20 }, (_, index) => ({
                candidateId: `legacy:${index}`, username: `legacy.${index}`,
                appearanceGrade: 1 as const, exposureScore: 0, accountContext: 'personal' as const,
                hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false,
                uniqueTargetPostsLikedByCandidate: index < 18 ? 4 : 0,
                boundedCandidateCommentsOnTarget: index < 3 ? 12 : index < 18 ? 6 : 0,
                hasTagOrCaptionMention: index < 18, recentFemaleMutualRank: null,
                recentMutualBadgeRank: null, preScore: 0, verificationShortlistRank: index < 10 ? index + 1 : null,
            }));
            const final = calculateLegacyV23FinalScores({
                preliminary, observedReverseLikeCandidateIds: new Set(['legacy:0']),
            });
            expect(final.find(row => row.candidateId === 'legacy:0')?.risk.components.targetToCandidateLike)
                .toBe(3);
            expect(final.filter(row => row.riskBand === 'caution' && row.featuredRank !== null)).toHaveLength(15);
        });

        it('excludes every strong-partner account from v2.3 relative eligibility, even below the cap', () => {
            const base = (candidateId: string, strong = false) => ({
                candidateId, username: candidateId.replace(':', '.'),
                appearanceGrade: 1 as const, exposureScore: 0, accountContext: 'personal' as const,
                hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: strong,
                uniqueTargetPostsLikedByCandidate: 0, boundedCandidateCommentsOnTarget: 0,
                hasTagOrCaptionMention: false, recentFemaleMutualRank: null,
                recentMutualBadgeRank: null, preScore: 0, verificationShortlistRank: null,
            });
            const final = calculateLegacyV23FinalScores({
                preliminary: [base('strong:low', true), base('eligible:one'), base('eligible:two')],
                observedReverseLikeCandidateIds: new Set(),
            });
            const strong = final.find(row => row.candidateId === 'strong:low')!;
            expect(strong.risk.publicScore).toBe(1);
            expect(strong.riskBand).toBe('normal');
            expect(strong.relativeTierApplied).toBe(false);
            expect(final.filter(row => row.relativeTierApplied)).toHaveLength(0);
        });

        it('assigns v2.3 relative-watch ranks to the two best non-featured candidates at 20 rows', () => {
            const final = calculateLegacyV23FinalScores({
                preliminary: Array.from({ length: 20 }, (_, index) => ({
                    candidateId: `watch:${String(index).padStart(2, '0')}`,
                    username: `watch.${index}`, appearanceGrade: 1 as const,
                    exposureScore: 0, accountContext: 'personal' as const,
                    hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false,
                    uniqueTargetPostsLikedByCandidate: index < 18 ? 4 : 0,
                    boundedCandidateCommentsOnTarget: index < 3 ? 12 : index < 18 ? 6 : 0,
                    hasTagOrCaptionMention: index < 18, recentFemaleMutualRank: null,
                    recentMutualBadgeRank: null, preScore: 0,
                    verificationShortlistRank: index < 10 ? index + 1 : null,
                })),
                observedReverseLikeCandidateIds: new Set(),
            });
            expect(final.filter(row => row.relativeWatchRank !== null).map(row => ({
                candidateId: row.candidateId, rank: row.relativeWatchRank,
            }))).toEqual([
                { candidateId: 'watch:16', rank: 1 },
                { candidateId: 'watch:17', rank: 2 },
            ]);
        });
    });
});
