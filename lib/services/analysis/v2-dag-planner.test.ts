import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAnalysisPlan, type PlanId } from '../../domain/analysis/plan-catalog';
import {
    ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
    analysisV2JobInputHash,
} from './v2-coordinator';
import {
    ANALYSIS_V2_CANDIDATE_SCREENING_JOB_KEY,
    ANALYSIS_V2_FINALIZE_JOB_KEY,
    ANALYSIS_V2_FINAL_SCORE_JOB_KEY,
    ANALYSIS_V2_NARRATIVE_JOB_KEY,
    ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY,
    ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
    ANALYSIS_V2_REVERSE_LIKES_JOB_KEY,
    assertAnalysisV2DagJob,
    buildAnalysisV2DagPlan,
    getAnalysisV2DagReadiness,
    successorsForAnalysisV2Job,
    type AnalysisV2DagBatchManifest,
    type AnalysisV2DagBatchResultManifest,
    type AnalysisV2DagPlan,
    type AnalysisV2DagRelationshipManifest,
    type AnalysisV2DagState,
} from './v2-dag-planner';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

function digest(label: string): string {
    return createHash('sha256').update(label, 'utf8').digest('hex');
}

function baseState(planId: PlanId = 'plus'): AnalysisV2DagState {
    return {
        schemaVersion: 2,
        requestSnapshotHash: digest(`request:${planId}`),
        planId,
        planSnapshotHash: digest(`plan:${planId}`),
        girlfriendExclusion: {
            decisionHash: digest('girlfriend-exclusion'),
            excludedCount: 1,
        },
    };
}

function batches(
    itemCount: number,
    limit: number,
    label: string
): AnalysisV2DagBatchManifest[] {
    return Array.from({ length: Math.ceil(itemCount / limit) }, (_, batch) => ({
        batch,
        itemCount: Math.min(limit, itemCount - batch * limit),
        inputHash: digest(`${label}:input:${batch}`),
    }));
}

function relationships(
    planId: PlanId,
    publicCount: number,
    privateCount: number
): AnalysisV2DagRelationshipManifest {
    const detailedSelectedPublicCount = Math.min(
        publicCount,
        getAnalysisPlan(planId).detailedMutualLimit
    );
    return {
        revision: 3,
        resultHash: digest(`relationships:${planId}:${publicCount}:${privateCount}`),
        detectedMutualCount: publicCount + privateCount,
        publicCount,
        privateCount,
        detailedSelectedPublicCount,
        notScreenedPublicCount: publicCount - detailedSelectedPublicCount,
        profileBatches: batches(detailedSelectedPublicCount, 30, 'profile'),
        privateNameBatches: batches(privateCount, 100, 'private'),
    };
}

function batchResults(
    topology: readonly AnalysisV2DagBatchManifest[],
    label: string,
    plan: AnalysisV2DagPlan,
    producerJobKey: (batch: number) => string
): AnalysisV2DagBatchResultManifest[] {
    return topology.map(item => ({
        batch: item.batch,
        itemCount: item.itemCount,
        producerInputHash: job(plan, producerJobKey(item.batch)).inputHash,
        revision: 1,
        resultHash: digest(`${label}:result:${item.batch}`),
    }));
}

function job(plan: AnalysisV2DagPlan, jobKey: string) {
    const planned = plan.jobs.find(item => item.jobKey === jobKey);
    if (!planned) throw new Error(`Missing planned job: ${jobKey}`);
    return planned;
}

function completed(plan: AnalysisV2DagPlan, jobKey: string) {
    const planned = job(plan, jobKey);
    return { jobKey: planned.jobKey, inputHash: planned.inputHash };
}

function successors(plan: AnalysisV2DagPlan, jobKey: string) {
    return successorsForAnalysisV2Job(plan, completed(plan, jobKey));
}

function primaryReadyState(input: {
    planId?: PlanId;
    publicCount?: number;
    privateCount?: number;
} = {}): AnalysisV2DagState {
    const planId = input.planId ?? 'plus';
    const state = baseState(planId);
    const relationship = relationships(
        planId,
        input.publicCount ?? 2,
        input.privateCount ?? 1
    );
    let staged: AnalysisV2DagState = {
        ...state,
        relationships: relationship,
        targetEvidence: {
            revision: 2,
            resultHash: digest('target-evidence'),
            interactorCount: 123,
        },
    };
    const relationshipPlan = buildAnalysisV2DagPlan(requestId, staged);
    staged = {
        ...staged,
        profileFetchBatches: batchResults(
            relationship.profileBatches,
            'profile-fetch',
            relationshipPlan,
            batch => `track:profiles:batch:${batch}`
        ),
    };
    const profileFetchPlan = buildAnalysisV2DagPlan(requestId, staged);
    return {
        ...staged,
        profileAiBatches: batchResults(
            relationship.profileBatches,
            'profile-ai',
            profileFetchPlan,
            batch => `track:profile-ai:batch:${batch}`
        ),
    };
}

function screenedState(input: { privateCount?: number; verifiedFemaleCount?: number } = {}) {
    const state = primaryReadyState({ publicCount: 2, privateCount: input.privateCount ?? 1 });
    const verifiedFemaleCount = input.verifiedFemaleCount ?? 2;
    return {
        ...state,
        primaryJoin: {
            revision: 1,
            resultHash: digest('primary-join'),
            verifiedFemaleCount,
        },
        screening: {
            revision: 1,
            resultHash: digest('screening'),
            verifiedFemaleCount,
            shortlistCount: Math.min(verifiedFemaleCount, 10),
            shortlistHash: digest('shortlist'),
        },
    } satisfies AnalysisV2DagState;
}

function scoredState(input: { privateCount?: number; verifiedFemaleCount?: number } = {}) {
    const state = screenedState(input);
    const shortlistCount = state.screening!.shortlistCount;
    return {
        ...state,
        reverseLikes: {
            revision: 1,
            resultHash: digest('reverse-likes'),
            shortlistCount,
        },
        partnerSafety: {
            revision: 1,
            resultHash: digest('partner-safety'),
            shortlistCount,
        },
    } satisfies AnalysisV2DagState;
}

function narratedState(input: { privateCount?: number; verifiedFemaleCount?: number } = {}) {
    const state = scoredState(input);
    const featuredHighRiskCount = Math.min(state.screening!.verifiedFemaleCount, 2);
    return {
        ...state,
        finalScore: {
            revision: 1,
            resultHash: digest('final-score'),
            featuredHighRiskCount,
            narrativeCount: featuredHighRiskCount,
            narrativeBatchHash: digest('narrative-batch'),
        },
        narrative: {
            revision: 1,
            resultHash: digest('narrative'),
            narrativeCount: featuredHighRiskCount,
        },
    } satisfies AnalysisV2DagState;
}

describe('analysis V2 staged deterministic DAG planner', () => {
    it('plans bootstrap without requiring any future result manifest', () => {
        const state = baseState('basic');
        const plan = buildAnalysisV2DagPlan(requestId, state);

        expect(plan.jobs.map(item => item.jobKey)).toEqual([
            ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
            ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
        ]);
        expect(successors(plan, ANALYSIS_V2_BOOTSTRAP_JOB_KEY).map(item => item.jobKey)).toEqual([
            ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
            ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
        ]);
        expect(plan.readiness.primaryJoin).toEqual({
            ready: false,
            missing: ['relationships', 'target_evidence'],
        });
        expect(() => successors(plan, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY))
            .toThrow('successors are not ready');
    });

    it('keeps only bootstrap on the persisted foundation identity and scopes both root tracks', () => {
        const plan = buildAnalysisV2DagPlan(requestId, baseState('plus'));
        const bootstrap = job(plan, ANALYSIS_V2_BOOTSTRAP_JOB_KEY);
        const relationship = job(plan, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const target = job(plan, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY);

        expect(bootstrap).toMatchObject({
            track: 'coordinator',
            kind: 'bootstrap',
            batch: null,
            inputHash: analysisV2JobInputHash(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY),
        });
        expect(relationship).toMatchObject({
            track: 'relationships',
            kind: 'collection',
            batch: null,
        });
        expect(target).toMatchObject({
            track: 'target_evidence',
            kind: 'collection',
            batch: null,
        });
        expect(relationship.inputHash)
            .not.toBe(analysisV2JobInputHash(requestId, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY));
        expect(target.inputHash)
            .not.toBe(analysisV2JobInputHash(requestId, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY));
        expect(assertAnalysisV2DagJob(plan, completed(plan, relationship.jobKey)))
            .toBe(relationship);
    });

    it('binds root-track hashes to request, plan, and girlfriend-exclusion snapshots', () => {
        const baselineState = baseState('plus');
        const baseline = buildAnalysisV2DagPlan(requestId, baselineState);
        const bootstrapHash = job(baseline, ANALYSIS_V2_BOOTSTRAP_JOB_KEY).inputHash;
        const rootHashes = (plan: AnalysisV2DagPlan) => [
            job(plan, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY).inputHash,
            job(plan, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY).inputHash,
        ];
        const changedStates: AnalysisV2DagState[] = [
            { ...baselineState, requestSnapshotHash: digest('changed-request') },
            { ...baselineState, planSnapshotHash: digest('changed-plan-snapshot') },
            {
                ...baselineState,
                planId: 'standard',
                planSnapshotHash: digest('standard-plan-snapshot'),
            },
            {
                ...baselineState,
                girlfriendExclusion: {
                    decisionHash: digest('changed-exclusion'),
                    excludedCount: 0,
                },
            },
        ];

        for (const changedState of changedStates) {
            const changed = buildAnalysisV2DagPlan(requestId, changedState);
            expect(rootHashes(changed)).not.toEqual(rootHashes(baseline));
            expect(job(changed, ANALYSIS_V2_BOOTSTRAP_JOB_KEY).inputHash).toBe(bootstrapHash);
        }
    });

    it('fans out relationship batches without placeholders or a premature primary join', () => {
        const state = baseState('basic');
        state.relationships = relationships('basic', 350, 50);
        const plan = buildAnalysisV2DagPlan(requestId, state);
        const fanout = successors(plan, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);

        expect(state.relationships).toMatchObject({
            detectedMutualCount: 400,
            detailedSelectedPublicCount: 300,
            notScreenedPublicCount: 50,
        });
        expect(fanout.filter(item => item.track === 'profiles')).toHaveLength(10);
        expect(fanout.filter(item => item.track === 'private_names')).toHaveLength(1);
        expect(fanout.some(item => item.jobKey === ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY)).toBe(false);
        expect(plan.readiness.primaryJoin.missing).toEqual([
            'target_evidence',
            'profile_fetch_batches',
            'profile_ai_batches',
        ]);
    });

    it('streams each completed profile batch into AI and rejects result-order placeholders', () => {
        const state = baseState('plus');
        state.relationships = relationships('plus', 65, 0);
        const relationshipPlan = buildAnalysisV2DagPlan(requestId, state);
        state.profileFetchBatches = batchResults(
            state.relationships.profileBatches,
            'fetch',
            relationshipPlan,
            batch => `track:profiles:batch:${batch}`
        ).slice(0, 1);
        const plan = buildAnalysisV2DagPlan(requestId, state);

        expect(successors(plan, 'track:profiles:batch:0').map(item => item.jobKey))
            .toEqual(['track:profile-ai:batch:0']);
        expect(() => successors(plan, 'track:profiles:batch:1'))
            .toThrow('successors are not ready');

        const invalid = {
            ...baseState('plus'),
            relationships: state.relationships,
            profileAiBatches: [{
                batch: 0,
                itemCount: state.relationships.profileBatches[0].itemCount,
                producerInputHash: digest('future-profile-ai-producer'),
                revision: 1,
                resultHash: digest('future-profile-ai-result'),
            }],
        };
        expect(() => buildAnalysisV2DagPlan(requestId, invalid))
            .toThrow('profile AI result without profile fetch result');
    });

    it('fails closed when any batch result is detached from its exact producer input', () => {
        const relationship = relationships('plus', 2, 1);
        const relationshipState: AnalysisV2DagState = {
            ...baseState('plus'),
            relationships: relationship,
        };
        const relationshipPlan = buildAnalysisV2DagPlan(requestId, relationshipState);
        const fetchResults = batchResults(
            relationship.profileBatches,
            'fetch-lineage',
            relationshipPlan,
            batch => `track:profiles:batch:${batch}`
        );
        expect(() => buildAnalysisV2DagPlan(requestId, {
            ...relationshipState,
            profileFetchBatches: [{
                ...fetchResults[0],
                producerInputHash: digest('wrong-profile-producer'),
            }],
        })).toThrow('profile fetch producer input hash mismatch');

        const fetchState: AnalysisV2DagState = {
            ...relationshipState,
            profileFetchBatches: fetchResults,
        };
        const fetchPlan = buildAnalysisV2DagPlan(requestId, fetchState);
        const aiResults = batchResults(
            relationship.profileBatches,
            'ai-lineage',
            fetchPlan,
            batch => `track:profile-ai:batch:${batch}`
        );
        expect(() => buildAnalysisV2DagPlan(requestId, {
            ...fetchState,
            profileAiBatches: [{
                ...aiResults[0],
                producerInputHash: digest('wrong-ai-producer'),
            }],
        })).toThrow('profile AI producer input hash mismatch');

        const privateResults = batchResults(
            relationship.privateNameBatches,
            'private-lineage',
            relationshipPlan,
            batch => `track:private-names:batch:${batch}`
        );
        expect(() => buildAnalysisV2DagPlan(requestId, {
            ...relationshipState,
            privateNameBatches: [{
                ...privateResults[0],
                producerInputHash: digest('wrong-private-producer'),
            }],
        })).toThrow('private name producer input hash mismatch');
    });

    it('propagates result hashes downstream and rejects stale downstream producer lineage', () => {
        const baselineState = primaryReadyState({ publicCount: 2, privateCount: 0 });
        const baseline = buildAnalysisV2DagPlan(requestId, baselineState);

        const changedAiResult: AnalysisV2DagState = {
            ...baselineState,
            profileAiBatches: baselineState.profileAiBatches!.map((result, index) => (
                index === 0 ? { ...result, resultHash: digest('changed-ai-result') } : result
            )),
        };
        const changedAiPlan = buildAnalysisV2DagPlan(requestId, changedAiResult);
        expect(job(changedAiPlan, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY).inputHash)
            .not.toBe(job(baseline, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY).inputHash);

        const staleAiAfterFetchChange: AnalysisV2DagState = {
            ...baselineState,
            profileFetchBatches: baselineState.profileFetchBatches!.map((result, index) => (
                index === 0 ? { ...result, resultHash: digest('changed-fetch-result') } : result
            )),
        };
        expect(() => buildAnalysisV2DagPlan(requestId, staleAiAfterFetchChange))
            .toThrow('profile AI producer input hash mismatch');
    });

    it('never lets an early target completion propose a reduced-topology join', () => {
        const targetFirst: AnalysisV2DagState = {
            ...baseState('plus'),
            targetEvidence: {
                revision: 1,
                resultHash: digest('target-first'),
                interactorCount: 0,
            },
        };
        const early = buildAnalysisV2DagPlan(requestId, targetFirst);
        expect(successors(early, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY)).toEqual([]);

        const relationship = relationships('plus', 2, 1);
        const relationshipArrived: AnalysisV2DagState = {
            ...targetFirst,
            relationships: relationship,
        };
        const middle = buildAnalysisV2DagPlan(requestId, relationshipArrived);
        expect(successors(middle, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY)
            .some(item => item.jobKey === ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY)).toBe(false);
        expect(successors(middle, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY)).toEqual([]);

        let ready: AnalysisV2DagState = {
            ...relationshipArrived,
            profileFetchBatches: batchResults(
                relationship.profileBatches,
                'fetch',
                middle,
                batch => `track:profiles:batch:${batch}`
            ),
        };
        const withFetch = buildAnalysisV2DagPlan(requestId, ready);
        ready = {
            ...ready,
            profileAiBatches: batchResults(
                relationship.profileBatches,
                'ai',
                withFetch,
                batch => `track:profile-ai:batch:${batch}`
            ),
        };
        const final = buildAnalysisV2DagPlan(requestId, ready);
        expect(successors(final, 'track:profile-ai:batch:0').map(item => item.jobKey))
            .toEqual([ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY]);
    });

    it('builds one frozen primary join for every possible last predecessor', () => {
        const state = primaryReadyState({ publicCount: 65, privateCount: 121 });
        const plan = buildAnalysisV2DagPlan(requestId, state);
        const primary = job(plan, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY);
        const expectedProposers = [
            ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
            ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
            'track:profile-ai:batch:0',
            'track:profile-ai:batch:1',
            'track:profile-ai:batch:2',
        ].sort();

        expect(plan.readiness.primaryJoin.ready).toBe(true);
        expect(plan.primaryJoinProposers).toEqual(expectedProposers);
        expect(primary.inputHash)
            .not.toBe(analysisV2JobInputHash(requestId, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY));
        for (const predecessor of expectedProposers) {
            const proposed = successors(plan, predecessor)
                .find(item => item.jobKey === ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY);
            expect(proposed).toBe(primary);
        }
        expect(primary.requiredJobKeys).toEqual(expectedProposers);
        expect(primary.requiredJobKeys.some(key => key.startsWith('track:private-names:')))
            .toBe(false);
    });

    it('also handles both valid zero-public predecessor completion orders', () => {
        const relationship = relationships('plus', 0, 2);
        const relationshipFirst: AnalysisV2DagState = {
            ...baseState('plus'),
            relationships: relationship,
        };
        const beforeTarget = buildAnalysisV2DagPlan(requestId, relationshipFirst);
        expect(successors(beforeTarget, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY)
            .some(item => item.jobKey === ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY)).toBe(false);

        const both: AnalysisV2DagState = {
            ...relationshipFirst,
            targetEvidence: {
                revision: 1,
                resultHash: digest('zero-public-target'),
                interactorCount: 0,
            },
        };
        const relationshipThenTarget = buildAnalysisV2DagPlan(requestId, both);
        expect(successors(relationshipThenTarget, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY)
            .map(item => item.jobKey)).toEqual([ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY]);

        const targetOnly: AnalysisV2DagState = {
            ...baseState('plus'),
            targetEvidence: both.targetEvidence,
        };
        expect(successors(
            buildAnalysisV2DagPlan(requestId, targetOnly),
            ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY
        )).toEqual([]);
        const targetThenRelationship = buildAnalysisV2DagPlan(requestId, both);
        expect(successors(targetThenRelationship, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY)
            .find(item => item.jobKey === ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY))
            .toBe(job(targetThenRelationship, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY));
    });

    it.each([
        ['basic', 400, 300, 10],
        ['standard', 800, 600, 20],
        ['plus', 1_200, 900, 30],
    ] as const)(
        'separates %s full mutual detection from detailed public screening',
        (planId, detected, selected, expectedBatches) => {
            const state = baseState(planId);
            state.relationships = relationships(planId, detected, 0);
            const plan = buildAnalysisV2DagPlan(requestId, state);

            expect(state.relationships).toMatchObject({
                detectedMutualCount: detected,
                publicCount: detected,
                detailedSelectedPublicCount: selected,
                notScreenedPublicCount: detected - selected,
            });
            expect(plan.jobs.filter(item => item.track === 'profiles')).toHaveLength(expectedBatches);
        }
    );

    it('represents all 1,200 Plus mutuals as private without mislabeling or truncation', () => {
        const state = baseState('plus');
        state.relationships = relationships('plus', 0, 1_200);
        const plan = buildAnalysisV2DagPlan(requestId, state);

        expect(state.relationships).toMatchObject({
            detectedMutualCount: 1_200,
            publicCount: 0,
            privateCount: 1_200,
            detailedSelectedPublicCount: 0,
        });
        expect(plan.jobs.filter(item => item.track === 'profiles')).toHaveLength(0);
        expect(plan.jobs.filter(item => item.track === 'private_names')).toHaveLength(12);
        expect(successors(plan, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY)).toHaveLength(12);
    });

    it('keeps private-name work off the public scoring critical path and joins it at finalize', () => {
        const withoutPrivateResults = narratedState({ privateCount: 121 });
        const before = buildAnalysisV2DagPlan(requestId, withoutPrivateResults);

        expect(before.readiness.primaryJoin.ready).toBe(true);
        expect(before.readiness.finalize).toEqual({
            ready: false,
            missing: ['private_name_batches'],
        });
        expect(successors(before, ANALYSIS_V2_NARRATIVE_JOB_KEY)).toEqual([]);

        const relationship = withoutPrivateResults.relationships!;
        const complete: AnalysisV2DagState = {
            ...withoutPrivateResults,
            privateNameBatches: batchResults(
                relationship.privateNameBatches,
                'private-name',
                before,
                batch => `track:private-names:batch:${batch}`
            ),
        };
        const after = buildAnalysisV2DagPlan(requestId, complete);
        const finalizer = job(after, ANALYSIS_V2_FINALIZE_JOB_KEY);
        const expectedProposers = [
            ANALYSIS_V2_NARRATIVE_JOB_KEY,
            'track:private-names:batch:0',
            'track:private-names:batch:1',
        ].sort();

        expect(after.readiness.finalize.ready).toBe(true);
        expect(after.finalizeProposers).toEqual(expectedProposers);
        for (const predecessor of expectedProposers) {
            expect(successors(after, predecessor)
                .find(item => item.jobKey === ANALYSIS_V2_FINALIZE_JOB_KEY)).toBe(finalizer);
        }
        expect(finalizer.requiredJobKeys).toEqual(expectedProposers);
    });

    it('makes either reverse or partner completion safely become the final-score predecessor', () => {
        const screened = screenedState();
        const reverseFirst: AnalysisV2DagState = {
            ...screened,
            reverseLikes: {
                revision: 1,
                resultHash: digest('reverse-first'),
                shortlistCount: screened.screening!.shortlistCount,
            },
        };
        const early = buildAnalysisV2DagPlan(requestId, reverseFirst);
        expect(successors(early, ANALYSIS_V2_REVERSE_LIKES_JOB_KEY)).toEqual([]);

        const both: AnalysisV2DagState = {
            ...reverseFirst,
            partnerSafety: {
                revision: 1,
                resultHash: digest('partner-second'),
                shortlistCount: screened.screening!.shortlistCount,
            },
        };
        const ready = buildAnalysisV2DagPlan(requestId, both);
        const finalScore = job(ready, ANALYSIS_V2_FINAL_SCORE_JOB_KEY);
        expect(ready.finalScoreProposers).toEqual([
            ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY,
            ANALYSIS_V2_REVERSE_LIKES_JOB_KEY,
        ]);
        expect(successors(ready, ANALYSIS_V2_REVERSE_LIKES_JOB_KEY)).toEqual([finalScore]);
        expect(successors(ready, ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY)).toEqual([finalScore]);
    });

    it('keeps shortlist, partner, narrative, and finalize zero-work branches durable', () => {
        const relationship = relationships('basic', 0, 0);
        const state: AnalysisV2DagState = {
            ...baseState('basic'),
            relationships: relationship,
            targetEvidence: {
                revision: 1,
                resultHash: digest('empty-target'),
                interactorCount: 0,
            },
            primaryJoin: {
                revision: 1,
                resultHash: digest('empty-primary'),
                verifiedFemaleCount: 0,
            },
            screening: {
                revision: 1,
                resultHash: digest('empty-screening'),
                verifiedFemaleCount: 0,
                shortlistCount: 0,
                shortlistHash: digest('empty-shortlist'),
            },
            reverseLikes: {
                revision: 1,
                resultHash: digest('empty-reverse'),
                shortlistCount: 0,
            },
            partnerSafety: {
                revision: 1,
                resultHash: digest('empty-partner'),
                shortlistCount: 0,
            },
            finalScore: {
                revision: 1,
                resultHash: digest('empty-score'),
                featuredHighRiskCount: 0,
                narrativeCount: 0,
                narrativeBatchHash: digest('empty-narrative-batch'),
            },
            narrative: {
                revision: 1,
                resultHash: digest('empty-narrative'),
                narrativeCount: 0,
            },
        };
        const plan = buildAnalysisV2DagPlan(requestId, state);

        expect(plan.jobs.some(item => item.jobKey.startsWith('track:profiles:'))).toBe(false);
        expect(successors(plan, ANALYSIS_V2_CANDIDATE_SCREENING_JOB_KEY)
            .map(item => item.jobKey)).toEqual([
            ANALYSIS_V2_REVERSE_LIKES_JOB_KEY,
            ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY,
        ]);
        expect(successors(plan, ANALYSIS_V2_FINAL_SCORE_JOB_KEY)
            .map(item => item.jobKey)).toEqual([ANALYSIS_V2_NARRATIVE_JOB_KEY]);
        expect(successors(plan, ANALYSIS_V2_NARRATIVE_JOB_KEY)
            .map(item => item.jobKey)).toEqual([ANALYSIS_V2_FINALIZE_JOB_KEY]);
        expect(successors(plan, ANALYSIS_V2_FINALIZE_JOB_KEY)).toEqual([]);
    });

    it('normalizes checkpoint arrival order and isolates private-only revision changes', () => {
        const state = narratedState({ privateCount: 121 });
        const beforePrivate = buildAnalysisV2DagPlan(requestId, state);
        state.privateNameBatches = batchResults(
            state.relationships!.privateNameBatches,
            'private',
            beforePrivate,
            batch => `track:private-names:batch:${batch}`
        );
        const reordered: AnalysisV2DagState = {
            ...state,
            profileFetchBatches: [...state.profileFetchBatches!].reverse(),
            profileAiBatches: [...state.profileAiBatches!].reverse(),
            privateNameBatches: [...state.privateNameBatches].reverse(),
        };
        const first = buildAnalysisV2DagPlan(requestId.toUpperCase(), state);
        const second = buildAnalysisV2DagPlan(requestId, reordered);
        expect(second).toEqual(first);

        const changedPrivate: AnalysisV2DagState = {
            ...state,
            privateNameBatches: state.privateNameBatches.map((item, index) => (
                index === 0 ? { ...item, revision: item.revision + 1 } : item
            )),
        };
        const changed = buildAnalysisV2DagPlan(requestId, changedPrivate);
        expect(job(changed, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY).inputHash)
            .toBe(job(first, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY).inputHash);
        expect(job(changed, ANALYSIS_V2_FINALIZE_JOB_KEY).inputHash)
            .not.toBe(job(first, ANALYSIS_V2_FINALIZE_JOB_KEY).inputHash);
        expect(changed.manifestFingerprint).not.toBe(first.manifestFingerprint);
    });

    it('rejects plan-limit drift, non-canonical batches, raw fields, and future placeholders', () => {
        const belowPlan = baseState('basic');
        belowPlan.relationships = {
            ...relationships('basic', 400, 0),
            detailedSelectedPublicCount: 400,
            notScreenedPublicCount: 0,
            profileBatches: batches(400, 30, 'bad-basic'),
        };
        expect(() => buildAnalysisV2DagPlan(requestId, belowPlan))
            .toThrow('invalid detailed selected public count');

        const nonCanonical = baseState('plus');
        nonCanonical.relationships = {
            ...relationships('plus', 31, 0),
            profileBatches: [
                { batch: 0, itemCount: 1, inputHash: digest('split-0') },
                { batch: 1, itemCount: 30, inputHash: digest('split-1') },
            ],
        };
        expect(() => buildAnalysisV2DagPlan(requestId, nonCanonical))
            .toThrow('non-canonical profile batch size');

        const leaked = baseState('plus') as unknown as Record<string, unknown>;
        leaked.girlfriendUsername = '0_min._.00';
        expect(() => buildAnalysisV2DagPlan(requestId, leaked as unknown as AnalysisV2DagState))
            .toThrow('invalid state fields');

        const future = {
            ...baseState('plus'),
            primaryJoin: {
                revision: 1,
                resultHash: digest('placeholder-primary'),
                verifiedFemaleCount: 0,
            },
        } as AnalysisV2DagState;
        expect(() => buildAnalysisV2DagPlan(requestId, future))
            .toThrow('primary join result before dependencies are ready');
    });

    it('fails closed for unknown, not-ready, and input-drifted completed jobs', () => {
        const plan = buildAnalysisV2DagPlan(requestId, baseState());
        expect(() => successorsForAnalysisV2Job(plan, {
            jobKey: 'track:unknown:batch:0',
            inputHash: digest('unknown'),
        })).toThrow('unknown completed job key');
        expect(() => successorsForAnalysisV2Job(plan, {
            jobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            inputHash: digest('drifted-input'),
        })).toThrow('completed job input hash mismatch');
        expect(() => successors(plan, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY))
            .toThrow('successors are not ready');
    });

    it('exposes the same strict readiness checks without constructing a job plan', () => {
        const state = primaryReadyState();
        expect(getAnalysisV2DagReadiness(requestId, state)).toMatchObject({
            relationshipFanout: { ready: true, missing: [] },
            primaryJoin: { ready: true, missing: [] },
            finalScore: {
                ready: false,
                missing: [
                    'screening_result',
                    'reverse_likes_result',
                    'partner_safety_result',
                ],
            },
            finalize: {
                ready: false,
                missing: ['narrative_result', 'private_name_batches'],
            },
        });
    });

    it('keeps maximum plan fanout and dependency counts inside the job-store contract', () => {
        const state = primaryReadyState({
            planId: 'plus',
            publicCount: 900,
            privateCount: 300,
        });
        const plan = buildAnalysisV2DagPlan(requestId, state);

        expect(plan.primaryJoinProposers).toHaveLength(32);
        expect(plan.proposals.every(item => item.successors.length <= 100)).toBe(true);
        expect(plan.jobs.every(item => item.requiredJobKeys.length <= 64)).toBe(true);
        expect(successors(plan, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY)).toHaveLength(34);
    });
});
