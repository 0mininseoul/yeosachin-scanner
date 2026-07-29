import { describe, expect, it, vi } from 'vitest';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';
const testRunnerPolicies = vi.hoisted(() => new WeakMap<object, string>());

vi.mock('./replay-staged-ai-adapter', () => ({
    lookupReplayStagedAiAdapterPolicy: (runner: object) => (
        testRunnerPolicies.get(runner)
    ),
}));

import {
    analysisV2ReplayResolverReadyOutcome,
    replayFeatureShadowAdmissionCohort,
    runAnalysisV2AiReplay,
    type ReplayAiRunner,
} from './replay-runner';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import { historicalPartialSourceUniverseDigest } from './historical-partial-available-artifact';
import { parseReplayCliArgs } from '../../../../scripts/replay-analysis-v2';

function v27Runner(operations: ReplayAiRunner): ReplayAiRunner {
    const runner = Object.freeze({ ...operations });
    testRunnerPolicies.set(runner, 'ai-stage-policy-v2.7');
    return runner;
}

function v29Runner(operations: ReplayAiRunner): ReplayAiRunner {
    const runner = Object.freeze({ ...operations });
    testRunnerPolicies.set(runner, 'ai-stage-policy-v2.9');
    return runner;
}

function v210Runner(operations: ReplayAiRunner): ReplayAiRunner {
    const runner = Object.freeze({ ...operations });
    testRunnerPolicies.set(runner, 'ai-stage-policy-v2.10');
    return runner;
}

function v212Runner(operations: ReplayAiRunner): ReplayAiRunner {
    const runner = Object.freeze({ ...operations });
    testRunnerPolicies.set(runner, 'ai-stage-policy-v2.12');
    return runner;
}

function v213Runner(
    operations: ReplayAiRunner & {
        shadowFeature?: ReplayAiRunner['feature'];
    },
): ReplayAiRunner {
    const runner = Object.freeze({ ...operations });
    testRunnerPolicies.set(runner, 'ai-stage-policy-v2.13');
    return runner;
}

function v215Runner(
    operations: ReplayAiRunner & {
        shadowFeature?: ReplayAiRunner['feature'];
    },
): ReplayAiRunner {
    const runner = Object.freeze({ ...operations });
    testRunnerPolicies.set(runner, 'ai-stage-policy-v2.15');
    return runner;
}

function v216Runner(
    operations: ReplayAiRunner & {
        shadowFeature?: ReplayAiRunner['feature'];
    },
): ReplayAiRunner {
    const runner = Object.freeze({ ...operations });
    testRunnerPolicies.set(runner, 'ai-stage-policy-v2.16');
    return runner;
}

function diagnosticPartialCoverageCapability(
    aiStagePolicy:
        | 'ai-stage-policy-v2.9'
        | 'ai-stage-policy-v2.10'
        | 'ai-stage-policy-v2.13'
        | 'ai-stage-policy-v2.15'
        | 'ai-stage-policy-v2.16' =
        'ai-stage-policy-v2.9',
) {
    const parsed = parseReplayCliArgs([
        '--run',
        '--paid-ai',
        '--confirm-paid-ai',
        '--historical-partial-available',
        '--allow-low-partial-coverage',
        '--confirm-low-partial-coverage',
        `--evaluation-ai-policy=${aiStagePolicy}`,
        '--bundle=a.enc',
        '--key=a.key',
    ]);
    if (
        parsed.command !== 'run'
        || !('diagnosticPartialCoverageCapability' in parsed)
        || !parsed.diagnosticPartialCoverageCapability
    ) {
        throw new Error('TEST_DIAGNOSTIC_PARTIAL_COVERAGE_CAPABILITY_MISSING');
    }
    return parsed.diagnosticPartialCoverageCapability;
}

const bundle = {
    schemaVersion: 1 as const,
    createdAt: '2026-07-27T00:00:00.000Z', expiresAt: '2026-07-27T01:00:00.000Z',
    capture: {
        requestFingerprint: 'a'.repeat(64),
        sourceLineage: {
            selectedPlanId: 'standard' as const,
            policyVersions: {
                pipeline: 'v2' as const,
                aiStage: 'ai-stage-policy-v2.7' as const,
                risk: 'risk-policy-v2.4' as const,
            },
        },
    },
    profiles: [
        { ordinal: 1, isPrivate: false, username: 'public', fullName: null, hasProfileImage: true, bio: null, media: [
            { selectionId: 'm1', kind: 'feed' as const, postId: 'p1', caption: null, jpegBase64: '/9j/2Q==' },
            { selectionId: 'm2', kind: 'feed' as const, postId: 'p2', caption: null, jpegBase64: '/9j/2Q==' },
        ], triageSelectionIds: ['m1', 'm2'], featureSelectionIds: ['m1', 'm2'], resolverSelectionIds: ['m1', 'm2'], captions: [], coverage: { selectedCount: 2, normalizedCount: 2, failures: [] } },
        { ordinal: 2, isPrivate: true, username: 'private', fullName: null, hasProfileImage: false, bio: null, media: [], triageSelectionIds: [], featureSelectionIds: [], resolverSelectionIds: [], captions: [], coverage: { selectedCount: 0, normalizedCount: 0, failures: [] } },
    ], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
};

describe('AI-only replay runner', () => {
    it.each([
        {
            expected: 'ready_high_confirmed',
            assessment: {
                inferredGender: 'female' as const,
                confidence: 'high' as const,
                ownerConsistency: 'same_person' as const,
                evidenceSelectionIds: ['m1', 'm2'],
            },
        },
        {
            expected: 'evidence_insufficient',
            assessment: {
                inferredGender: 'female' as const,
                confidence: 'medium' as const,
                ownerConsistency: 'same_person' as const,
                evidenceSelectionIds: ['m1'],
            },
        },
        {
            expected: 'mixed',
            assessment: {
                inferredGender: 'unknown' as const,
                confidence: 'low' as const,
                ownerConsistency: 'mixed_people' as const,
                evidenceSelectionIds: ['m1', 'm2'],
            },
        },
        {
            expected: 'unknown',
            assessment: {
                inferredGender: 'unknown' as const,
                confidence: 'low' as const,
                ownerConsistency: 'not_visible' as const,
                evidenceSelectionIds: [],
            },
        },
    ])('classifies aggregate-only ready resolver outcome as $expected', ({
        assessment,
        expected,
    }) => {
        expect(analysisV2ReplayResolverReadyOutcome({
            assessment,
            analyzedSelectionIds: ['m1', 'm2'],
        })).toBe(expected);
    });

    function validPartialBundle(): Extract<AnalysisV2ReplayBundle, { schemaVersion: 2 }> {
        const sourceIdentities = [
            { ordinal: 1, username: 'public', partition: 'public' as const },
            { ordinal: 2, username: 'private', partition: 'private' as const },
        ];
        return {
            ...bundle,
            schemaVersion: 2,
            capture: {
                ...bundle.capture,
                scope: 'ai-only-historical-partial-available', notExact: true, fullE2eEvidence: false, noMediaSubstitution: true,
                sourceLineage: { selectedPlanId: 'standard', policyVersions: { pipeline: 'v2', aiStage: 'ai-stage-policy-v2.7', risk: 'risk-policy-v2.3' } },
                evaluationPolicy: { capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' },
                partial: { sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities), sourceIdentities, mediaUnavailable: [] },
            },
        };
    }

    function eligiblePaidPartialBundle(): ReturnType<typeof validPartialBundle> {
        const publicProfiles = Array.from({ length: 379 }, (_, profileIndex) => {
            const mediaCount = 5 + (profileIndex < 9 ? 1 : 0);
            const media = Array.from({ length: mediaCount }, (_, mediaIndex) => {
                const selectionId = `m-${profileIndex + 1}-${mediaIndex + 1}`;
                return { selectionId, kind: 'feed' as const, postId: `p-${profileIndex + 1}-${mediaIndex + 1}`, caption: null, jpegBase64: '/9j/2Q==' };
            });
            return {
                ordinal: profileIndex + 1,
                isPrivate: false,
                username: `public_${profileIndex + 1}`,
                fullName: null,
                hasProfileImage: true,
                bio: null,
                media,
                triageSelectionIds: media.slice(0, 2).map(item => item.selectionId),
                featureSelectionIds: media.map(item => item.selectionId),
                resolverSelectionIds: media.map(item => item.selectionId),
                captions: [],
                coverage: {
                    selectedCount: mediaCount + (profileIndex < 11 ? 1 : 0),
                    normalizedCount: mediaCount,
                    failures: profileIndex < 11
                        ? [{ selectionId: `failed-${profileIndex + 1}`, reason: 'normalization_failed', disposition: 'permanent' as const }]
                        : [],
                },
            };
        });
        const privateProfile = { ...bundle.profiles[1]!, ordinal: 380, username: 'private_380' };
        const sourceIdentities = [
            ...publicProfiles.map(profile => ({ ordinal: profile.ordinal, username: profile.username, partition: 'public' as const })),
            { ordinal: 380, username: 'private_380', partition: 'private' as const },
            ...Array.from({ length: 5 }, (_, index) => ({ ordinal: 381 + index, username: `terminal_${381 + index}`, partition: 'fetch_terminal' as const })),
        ];
        const value = validPartialBundle();
        return {
            ...value,
            profiles: [...publicProfiles, privateProfile],
            capture: { ...value.capture, partial: {
                sourceIdentities,
                sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
                mediaUnavailable: [],
            } },
        };
    }

    function diagnosticPaidPartialBundle(): ReturnType<typeof validPartialBundle> {
        const retainedProfiles = Array.from({ length: 49 }, (_, index) => {
            const selectionId = `diagnostic-media-${index + 1}`;
            return {
                ...bundle.profiles[0]!,
                ordinal: index + 1,
                username: `diagnostic_${index + 1}`,
                media: [{
                    selectionId,
                    kind: 'feed' as const,
                    postId: `diagnostic-post-${index + 1}`,
                    caption: null,
                    jpegBase64: '/9j/2Q==',
                }],
                triageSelectionIds: [selectionId],
                featureSelectionIds: [selectionId],
                resolverSelectionIds: [selectionId],
                coverage: { selectedCount: 1, normalizedCount: 1, failures: [] },
            };
        });
        const sourceIdentities = [
            ...retainedProfiles.map(profile => ({
                ordinal: profile.ordinal,
                username: profile.username,
                partition: 'public' as const,
            })),
            { ordinal: 50, username: 'diagnostic_unavailable', partition: 'public' as const },
        ];
        const value = validPartialBundle();
        return {
            ...value,
            profiles: retainedProfiles,
            capture: {
                ...value.capture,
                partial: {
                    sourceIdentities,
                    sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
                    mediaUnavailable: [{
                        ordinal: 50,
                        terminal: 'media_unavailable',
                        selectedMediaCount: 1,
                        triageFailures: 1,
                        featureFailures: 1,
                        reasons: ['source_missing'],
                    }],
                },
            },
        } as ReturnType<typeof validPartialBundle>;
    }

    const withIdentities = (
        value: ReturnType<typeof validPartialBundle>,
        sourceIdentities: ReturnType<typeof validPartialBundle>['capture']['partial']['sourceIdentities'],
    ) => ({ ...value, capture: { ...value.capture, partial: {
        ...value.capture.partial,
        sourceIdentities,
        sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
    } } });

    it('rejects a stale digest before a direct runner invocation', async () => {
        const value = validPartialBundle();
        const invalid = { ...value, capture: { ...value.capture, partial: { ...value.capture.partial, sourceUniverseDigest: '0'.repeat(64) } } };
        await expect(runAnalysisV2AiReplay({ bundle: invalid, mode: 'dry-run', evaluationPolicy: invalid.capture.evaluationPolicy })).rejects.toThrow('ANALYSIS_V2_REPLAY_INPUT_INVALID');
    });

    it.each([
        (value: ReturnType<typeof validPartialBundle>) => withIdentities(value, [...value.capture.partial.sourceIdentities, { ordinal: 8, username: 'PUBLIC', partition: 'fetch_terminal' as const }]),
        (value: ReturnType<typeof validPartialBundle>) => withIdentities(value, value.capture.partial.sourceIdentities.slice(0, 1)),
        (value: ReturnType<typeof validPartialBundle>) => withIdentities(value, value.capture.partial.sourceIdentities.map(identity => identity.ordinal === 1 ? { ...identity, partition: 'private' as const } : identity)),
    ])('rejects an identity invariant with a matching recomputed digest before direct runner invocation %#', async mutate => {
        const invalid = mutate(validPartialBundle());
        await expect(runAnalysisV2AiReplay({ bundle: invalid, mode: 'dry-run', evaluationPolicy: invalid.capture.evaluationPolicy })).rejects.toThrow('ANALYSIS_V2_REPLAY_INPUT_INVALID');
    });

    it.each([
        { ...bundle, capture: { ...bundle.capture, evaluationPolicy: { capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' } } },
        { ...bundle, schemaVersion: 2, capture: { ...bundle.capture, scope: 'ai-only-historical-partial-available', notExact: true, fullE2eEvidence: false, noMediaSubstitution: true, partial: { sourceUniverseDigest: historicalPartialSourceUniverseDigest([]), sourceIdentities: [], mediaUnavailable: [] } } },
        { ...bundle, schemaVersion: 2, capture: { ...bundle.capture, scope: 'ai-only-historical-partial-available', notExact: true, fullE2eEvidence: false, noMediaSubstitution: true, evaluationPolicy: { capability: 'historical-official-e2e-standard-v27-risk-v23-to-ai-v29', aiStage: 'ai-stage-policy-v2.9' }, partial: { sourceUniverseDigest: historicalPartialSourceUniverseDigest([]), sourceIdentities: [], mediaUnavailable: [] } } },
    ])('rejects cross-version artifact capability at the runner boundary %#', async invalid => {
        await expect(runAnalysisV2AiReplay({ bundle: invalid as AnalysisV2ReplayBundle, mode: 'dry-run', ...('evaluationPolicy' in invalid.capture ? { evaluationPolicy: invalid.capture.evaluationPolicy as never } : {}) })).rejects.toThrow('ANALYSIS_V2_REPLAY_ARTIFACT_CAPABILITY_MISMATCH');
    });

    it('dry-run validates inputs without calling AI and emits only safe aggregate metrics', async () => {
        const triage = vi.fn();
        const lines: string[] = [];
        const report = await runAnalysisV2AiReplay({ bundle, runner: { triage }, mode: 'dry-run', write: line => lines.push(line) });
        expect(triage).not.toHaveBeenCalled();
        expect(report.stages.genderTriage.calls).toBe(0);
        expect(lines.join('\n')).not.toContain('m1');
        expect(lines.join('\n')).not.toContain('a'.repeat(64));
        expect(lines.join('\n')).not.toContain('public');
        expect(JSON.parse(lines[0]!)).toMatchObject({
            benchmark_scope: 'ai-only-exact-replay',
            source_plan: 'standard',
            source_pipeline: 'v2',
            source_ai_policy: 'ai-stage-policy-v2.7',
            source_risk_policy: 'risk-policy-v2.4',
            replay_ai_policy: 'ai-stage-policy-v2.7',
            full_e2e_evidence: false,
        });
        expect(Object.values(
            JSON.parse(lines[0]!).stages as Record<string, object>,
        ).every(
            (stage: object) => !Object.hasOwn(stage, 'failure_kind'),
        )).toBe(true);
        expect(report.stages.genderTriage).not.toHaveProperty('failureKind');
    });

    it('reports authenticated partial v2.10 without weakening non-exact scope labels', async () => {
        const partial = validPartialBundle();
        const evaluationPolicy = {
            capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v210',
            aiStage: 'ai-stage-policy-v2.10',
        } as const;
        const partialV210 = {
            ...partial,
            capture: { ...partial.capture, evaluationPolicy },
        } satisfies AnalysisV2ReplayBundle;
        const report = await runAnalysisV2AiReplay({
            bundle: partialV210,
            mode: 'dry-run',
            evaluationPolicy,
        });

        expect(report).toMatchObject({
            benchmarkScope: 'ai-only-historical-partial-available',
            evaluationAiPolicy: 'ai-stage-policy-v2.10',
            replayAiPolicy: 'ai-stage-policy-v2.10',
            fullE2eEvidence: false,
            notExact: true,
            noMediaSubstitution: true,
        });
    });

    it('runs eligible partial paid replay through the authenticated v2.9 stages and preserves aggregate-only scope labels', async () => {
        const triage = vi.fn(async () => ({
            outcome: 'ok' as const,
            value: {
                assessment: { inferredGender: 'female' as const, confidence: 'high' as const, ownerConsistency: 'same_person' as const, evidenceSelectionIds: ['m1', 'm2'] },
                routingDecision: 'route_to_feature_analysis' as const,
                routingReason: 'conserve_female_recall' as const,
                analyzedSelectionIds: ['m1', 'm2'],
                v29AccountContext: 'personal' as const,
            },
            attempts: 1, retries: 0, elapsedMs: 1,
        }));
        const feature = vi.fn(async () => ({ outcome: 'rate_limited' as const, attempts: 1, retries: 0, elapsedMs: 1 }));
        const privateNames = vi.fn(async () => ({ outcome: 'ok' as const, attempts: 1, retries: 0, elapsedMs: 1 }));
        const lines: string[] = [];
        const partial = eligiblePaidPartialBundle();
        await runAnalysisV2AiReplay({
            bundle: partial,
            runner: v29Runner({ triage, feature, privateNames }),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: partial.capture.evaluationPolicy,
            write: line => lines.push(line),
        });
        expect(triage).toHaveBeenCalledTimes(379);
        expect(feature).toHaveBeenCalledTimes(379);
        expect(privateNames).toHaveBeenCalledOnce();
        expect(JSON.parse(lines[0]!)).toMatchObject({
            benchmark_scope: 'ai-only-historical-partial-available',
            not_exact: true,
            full_e2e_evidence: false,
            no_media_substitution: true,
            replay_ai_policy: 'ai-stage-policy-v2.9',
        });
    });

    it('admits v2.10 exact-count diagnostic coverage only through double-confirmed CLI capability', async () => {
        const triage = vi.fn(async () => ({
            outcome: 'ok' as const,
            value: {
                assessment: { inferredGender: 'male' as const, confidence: 'high' as const, ownerConsistency: 'same_person' as const, evidenceSelectionIds: ['diagnostic-media-1'] },
                routingDecision: 'exclude_high_confidence_male' as const,
                routingReason: 'high_confidence_same_owner_male' as const,
                analyzedSelectionIds: ['diagnostic-media-1'],
                v29AccountContext: 'personal' as const,
            },
            attempts: 1, retries: 0, elapsedMs: 1,
        }));
        const basePartial = diagnosticPaidPartialBundle();
        const evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v210',
            aiStage: 'ai-stage-policy-v2.10',
        } as const;
        const partial = {
            ...basePartial,
            capture: {
                ...basePartial.capture,
                evaluationPolicy,
            },
        } satisfies AnalysisV2ReplayBundle;
        const lines: string[] = [];

        await expect(runAnalysisV2AiReplay({
            bundle: partial,
            runner: v210Runner({ triage }),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_PARTIAL_COVERAGE_INSUFFICIENT');
        expect(triage).not.toHaveBeenCalled();

        const report = await runAnalysisV2AiReplay({
            bundle: partial,
            runner: v210Runner({ triage }),
            mode: 'paid-ai',
            paidAiOptIn: true,
            diagnosticPartialCoverageCapability:
                diagnosticPartialCoverageCapability(
                    'ai-stage-policy-v2.10',
                ),
            evaluationPolicy,
            write: line => lines.push(line),
        });

        expect(triage).toHaveBeenCalledTimes(49);
        expect(report).toMatchObject({
            fullE2eEvidence: false,
            notExact: true,
            noMediaSubstitution: true,
            evaluationAiPolicy: 'ai-stage-policy-v2.10',
            replayAiPolicy: 'ai-stage-policy-v2.10',
            diagnosticCoverageOverride: {
                used: true,
                retainedProfiles: 49,
                sourceProfiles: 50,
                retainedMedia: 49,
                exactSelectedMedia: 50,
                profileRetentionBps: 9_800,
                mediaRetentionBps: 9_800,
            },
        });
        const safe = JSON.parse(lines[0]!);
        expect(safe).toMatchObject({
            full_e2e_evidence: false,
            not_exact: true,
            no_media_substitution: true,
            diagnostic_partial_coverage_override: {
                used: true,
                retained_profiles: 49,
                source_profiles: 50,
                retained_media: 49,
                exact_selected_media: 50,
                profile_retention_bps: 9_800,
                media_retention_bps: 9_800,
            },
        });
        expect(lines.join('')).not.toContain('diagnostic_1');
        expect(lines.join('')).not.toContain('diagnostic-media');
    });

    it('rejects direct boolean and forged diagnostic approval before any AI call', async () => {
        const triage = vi.fn();
        const feature = vi.fn();
        const privateNames = vi.fn();
        const resolveGender = vi.fn();
        const partial = diagnosticPaidPartialBundle();
        const runner = v29Runner({
            triage,
            feature,
            privateNames,
            resolveGender,
        });

        await expect(runAnalysisV2AiReplay({
            bundle: partial,
            runner,
            mode: 'paid-ai',
            paidAiOptIn: true,
            allowLowPartialCoverage: true,
            evaluationPolicy: partial.capture.evaluationPolicy,
        } as Parameters<typeof runAnalysisV2AiReplay>[0])).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_AUTHORIZATION_REQUIRED',
        );
        await expect(runAnalysisV2AiReplay({
            bundle: partial,
            runner,
            mode: 'paid-ai',
            paidAiOptIn: true,
            diagnosticPartialCoverageCapability: Object.freeze({}),
            evaluationPolicy: partial.capture.evaluationPolicy,
        } as Parameters<typeof runAnalysisV2AiReplay>[0])).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_AUTHORIZATION_REQUIRED',
        );

        expect(triage).not.toHaveBeenCalled();
        expect(feature).not.toHaveBeenCalled();
        expect(privateNames).not.toHaveBeenCalled();
        expect(resolveGender).not.toHaveBeenCalled();
    });

    it('rejects diagnostic coverage for legacy countless partial artifacts before AI', async () => {
        const triage = vi.fn();
        const partial = diagnosticPaidPartialBundle();
        const legacy = {
            ...partial,
            capture: {
                ...partial.capture,
                partial: {
                    ...partial.capture.partial,
                    mediaUnavailable: partial.capture.partial.mediaUnavailable.map(item => {
                        const rest = { ...item };
                        delete rest.selectedMediaCount;
                        return rest;
                    }),
                },
            },
        } as ReturnType<typeof validPartialBundle>;

        await expect(runAnalysisV2AiReplay({
            bundle: legacy,
            runner: v29Runner({ triage }),
            mode: 'paid-ai',
            paidAiOptIn: true,
            diagnosticPartialCoverageCapability:
                diagnosticPartialCoverageCapability(),
            evaluationPolicy: legacy.capture.evaluationPolicy,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_PARTIAL_COVERAGE_INSUFFICIENT');
        expect(triage).not.toHaveBeenCalled();
    });

    it('requires the authenticated historical capability on every run', async () => {
        const historicalBundle = {
            ...bundle,
            capture: {
                ...bundle.capture,
                sourceLineage: {
                    selectedPlanId: 'standard' as const,
                    policyVersions: {
                        pipeline: 'v2' as const,
                        aiStage: 'ai-stage-policy-v2.7' as const,
                        risk: 'risk-policy-v2.3' as const,
                    },
                },
                evaluationPolicy: {
                    capability: 'historical-official-e2e-standard-v27-risk-v23-to-ai-v29' as const,
                    aiStage: 'ai-stage-policy-v2.9' as const,
                },
            },
        };
        await expect(runAnalysisV2AiReplay({
            bundle: historicalBundle, mode: 'dry-run',
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_MISMATCH');
        await expect(runAnalysisV2AiReplay({
            bundle: historicalBundle,
            mode: 'dry-run',
            evaluationPolicy: historicalBundle.capture.evaluationPolicy,
        })).resolves.toMatchObject({ replayAiPolicy: 'ai-stage-policy-v2.9' });
    });

    it('rejects malformed normalized input during dry-run before invoking AI', async () => {
        const triage = vi.fn();
        await expect(runAnalysisV2AiReplay({
            bundle: { ...bundle, profiles: [{ ...bundle.profiles[0], media: [{ selectionId: 'm1', kind: 'feed', caption: null, jpegBase64: 'aGVsbG8=' }] }] },
            runner: { triage }, mode: 'dry-run',
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_INPUT_INVALID');
        expect(triage).not.toHaveBeenCalled();
    });

    it('never relabels a historical Plus source as Standard evidence', async () => {
        const lines: string[] = [];
        await expect(runAnalysisV2AiReplay({
            bundle: {
                ...bundle,
                capture: {
                    requestFingerprint: 'b'.repeat(64),
                    sourceLineage: {
                        selectedPlanId: 'plus',
                        policyVersions: {
                            pipeline: 'v2',
                            aiStage: 'ai-stage-policy-v2.4',
                            risk: 'risk-policy-v2.2',
                        },
                    },
                },
            },
            runner: {},
            mode: 'dry-run',
            write: line => lines.push(line),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_AI_POLICY_UNSUPPORTED');
        expect(lines).toEqual([]);
    });

    it('replays an exact v2.8 bundle using v2.8 rather than ambient latest policy', async () => {
        const lines: string[] = [];
        const report = await runAnalysisV2AiReplay({
            bundle: {
                ...bundle,
                capture: {
                    ...bundle.capture,
                    sourceLineage: {
                        selectedPlanId: 'standard',
                        policyVersions: {
                            pipeline: 'v2',
                            risk: 'risk-policy-v2.4',
                            aiStage: 'ai-stage-policy-v2.8',
                            scheduler: 'ai-scheduler-v1',
                        },
                    },
                },
            },
            runner: {},
            mode: 'dry-run',
            write: line => lines.push(line),
        });
        expect(report.replayAiPolicy).toBe('ai-stage-policy-v2.8');
        expect(JSON.parse(lines[0]!)).toMatchObject({
            source_ai_policy: 'ai-stage-policy-v2.8',
            replay_ai_policy: 'ai-stage-policy-v2.8',
        });
    });

    it('rejects a v2.7 runner for a v2.8 bundle before any paid AI call', async () => {
        const triage = vi.fn();
        const privateNames = vi.fn();
        const v28Bundle = {
            ...bundle,
            capture: {
                ...bundle.capture,
                sourceLineage: {
                    selectedPlanId: 'standard' as const,
                    policyVersions: {
                        pipeline: 'v2' as const,
                        risk: 'risk-policy-v2.4' as const,
                        aiStage: 'ai-stage-policy-v2.8' as const,
                        scheduler: 'ai-scheduler-v1' as const,
                    },
                },
            },
        };

        await expect(runAnalysisV2AiReplay({
            bundle: v28Bundle,
            runner: v27Runner({ triage, privateNames }),
            mode: 'paid-ai',
            paidAiOptIn: true,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_AI_RUNNER_POLICY_MISMATCH');
        expect(triage).not.toHaveBeenCalled();
        expect(privateNames).not.toHaveBeenCalled();

        await expect(runAnalysisV2AiReplay({
            bundle: v28Bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_AI_RUNNER_POLICY_MISMATCH');
    });

    it('requires explicit paid-ai mode, summarizes retry/rate-limit/outcome metrics, and has no persistence dependency', async () => {
        const runner = v27Runner({
            triage: vi.fn(async () => ({ outcome: 'ok' as const, value: { assessment: { inferredGender: 'female' as const, confidence: 'medium' as const, ownerConsistency: 'same_person' as const, evidenceSelectionIds: ['m1'] }, routingDecision: 'route_to_feature_analysis' as const, routingReason: 'conserve_female_recall' as const, analyzedSelectionIds: ['m1'] }, attempts: 2, retries: 1, elapsedMs: 20 })),
            feature: vi.fn(async () => ({ outcome: 'rate_limited' as const, attempts: 1, retries: 0, elapsedMs: 30 })),
            privateNames: vi.fn(async () => ({
                outcome: 'ok' as const,
                calls: 1,
                attempts: 1,
                retries: 0,
                elapsedMs: 10,
                attemptLatenciesMs: [4],
                failureDisposition: { response_rejected: 1 },
            })),
        });
        await expect(runAnalysisV2AiReplay({ bundle, runner, mode: 'paid-ai' })).rejects.toThrow('ANALYSIS_V2_REPLAY_PAID_AI_OPT_IN_REQUIRED');
        const report = await runAnalysisV2AiReplay({ bundle, runner, mode: 'paid-ai', paidAiOptIn: true });
        expect(report.stages.genderTriage).toMatchObject({ calls: 1, retries: 1, meanLatencyMs: 20 });
        expect(report.stages.featureAnalysis).toMatchObject({ calls: 1, rateLimited: 1, failureDisposition: { rate_limited: 1 } });
        expect(report.gender).toEqual({ male: 0, female: 0, unknown: 1, unknownRate: 1 });
        expect(report.stages.privateAccountName).toMatchObject({
            calls: 1,
            meanLatencyMs: 4,
            p50LatencyMs: 4,
            p95LatencyMs: 4,
        });
        expect(report.stages.privateAccountName.failureDisposition)
            .toEqual({ response_rejected: 1 });
    });

    it('rejects an unknown adapter disposition at the typed normalization boundary', async () => {
        const runner = v27Runner({
            triage: vi.fn(async () => ({
                outcome: 'ok' as const,
                value: {
                    assessment: {
                        inferredGender: 'male' as const,
                        confidence: 'high' as const,
                        ownerConsistency: 'same_person' as const,
                        evidenceSelectionIds: ['m1'],
                    },
                    routingDecision: 'exclude_high_confidence_male' as const,
                    routingReason: 'high_confidence_same_owner_male' as const,
                    analyzedSelectionIds: ['m1'],
                },
                attempts: 1,
                retries: 0,
                elapsedMs: 1,
            })),
            privateNames: vi.fn(async () => ({
                outcome: 'ok' as const,
                attempts: 1,
                retries: 0,
                elapsedMs: 1,
                failureDisposition: {
                    private_handle: 1,
                },
            })) as unknown as NonNullable<ReplayAiRunner['privateNames']>,
        });

        await expect(runAnalysisV2AiReplay({
            bundle,
            runner,
            mode: 'paid-ai',
            paidAiOptIn: true,
        })).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_FAILURE_DISPOSITION_INVALID',
        );
    });

    it('excludes only a high-confidence same-owner male before feature work', async () => {
        const feature = vi.fn();
        const report = await runAnalysisV2AiReplay({
            bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            runner: v27Runner({
                triage: async () => ({
                    outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 1,
                    value: {
                        assessment: { inferredGender: 'male', confidence: 'high', ownerConsistency: 'same_person', evidenceSelectionIds: ['m1'] },
                        routingDecision: 'exclude_high_confidence_male',
                        routingReason: 'high_confidence_same_owner_male',
                        analyzedSelectionIds: ['m1', 'm2'],
                    },
                }),
                feature,
            }),
        });
        expect(feature).not.toHaveBeenCalled();
        expect(report.gender).toEqual({ male: 1, female: 0, unknown: 0, unknownRate: 0 });
    });

    it('starts feature and resolver together and applies the production reconciliation to final gender', async () => {
        let resolverStarted = false;
        const featureResult = {
            features: {
                gender: 'female', genderConfidence: 'medium', ownerConsistency: 'same_person',
                appearanceGrade: 3, exposureScore: 1, businessClassification: 'personal',
                businessConfidence: 'medium', accountContext: 'personal',
                marriageEvidence: 'none', partnerEvidence: 'none', partnerExclusionContext: 'none',
                evidenceSelectionIds: { gender: ['m1'], appearance: ['m1'], exposure: ['m1'], business: ['m1'], accountContext: ['m1'], marriagePartner: [] },
                oneLineOverview: '구체적인 관찰을 바탕으로 계정 맥락을 정리한 충분히 긴 한국어 총평입니다.',
            },
            finalGenderDecision: 'unresolved' as const,
            analyzedSelectionIds: ['m1', 'm2'],
        } satisfies FeatureAnalysisResult;
        const report = await runAnalysisV2AiReplay({
            bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            runner: v27Runner({
                triage: async () => ({
                    outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 1,
                    value: {
                        assessment: { inferredGender: 'unknown', confidence: 'low', ownerConsistency: 'multiple_or_unclear', evidenceSelectionIds: ['m1'] },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: ['m1', 'm2'],
                    },
                }),
                feature: async () => {
                    await Promise.resolve();
                    expect(resolverStarted).toBe(true);
                    return { outcome: 'ok', value: featureResult, attempts: 1, retries: 0, elapsedMs: 2 };
                },
                resolveGender: async () => {
                    resolverStarted = true;
                    return {
                        outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 3,
                        value: {
                            assessment: { inferredGender: 'female', confidence: 'high', ownerConsistency: 'same_person', evidenceSelectionIds: ['m1', 'm2'] },
                            analyzedSelectionIds: ['m1', 'm2'],
                        },
                    };
                },
            }),
        });
        expect(report.gender).toEqual({ male: 0, female: 1, unknown: 0, unknownRate: 0 });
        expect(report.resolver).toMatchObject({ ready: 1, applied: 1, inconclusive: 0, cutoff: 0 });
    });

    it('reports only bounded aggregate resolver headroom diagnostics', async () => {
        const evaluationPolicy = {
            capability: 'historical-official-e2e-standard-v27-risk-v23-to-ai-v212-gender-quality' as const,
            aiStage: 'ai-stage-policy-v2.12' as const,
        };
        const publicProfiles = [1, 2, 3, 4, 5].map(ordinal => ({
            ...bundle.profiles[0]!,
            ordinal,
            username: `candidate-${ordinal}`,
        }));
        const v212Bundle = {
            ...bundle,
            capture: {
                ...bundle.capture,
                sourceLineage: {
                    selectedPlanId: 'standard' as const,
                    policyVersions: {
                        pipeline: 'v2' as const,
                        aiStage: 'ai-stage-policy-v2.7' as const,
                        risk: 'risk-policy-v2.3' as const,
                    },
                },
                evaluationPolicy,
            },
            profiles: publicProfiles,
        };
        const featureResult = (
            accountContext: 'personal' | 'individual_creator' | 'uncertain',
            finalGenderDecision: FeatureAnalysisResult['finalGenderDecision'],
        ): FeatureAnalysisResult => ({
            features: {
                gender: 'unknown', genderConfidence: 'low', ownerConsistency: 'multiple_or_unclear',
                appearanceGrade: 3, exposureScore: 1, businessClassification: 'personal',
                businessConfidence: 'medium', accountContext,
                marriageEvidence: 'none', partnerEvidence: 'none', partnerExclusionContext: 'none',
                evidenceSelectionIds: { gender: ['m1'], appearance: ['m1'], exposure: ['m1'], business: ['m1'], accountContext: ['m1'], marriagePartner: [] },
                oneLineOverview: '충분히 긴 형식 검증용 한국어 계정 맥락 요약입니다.',
            },
            finalGenderDecision,
            analyzedSelectionIds: ['m1', 'm2'],
        });
        const lines: string[] = [];

        const report = await runAnalysisV2AiReplay({
            bundle: v212Bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy,
            write: line => lines.push(line),
            runner: v212Runner({
                triage: async ({ ordinal }) => ({
                    outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 1,
                    value: {
                        assessment: ordinal === 2
                            ? { inferredGender: 'female', confidence: 'high', ownerConsistency: 'same_person', evidenceSelectionIds: ['m1', 'm2'] }
                            : { inferredGender: 'unknown', confidence: 'low', ownerConsistency: 'multiple_or_unclear', evidenceSelectionIds: ['m1'] },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: ['m1', 'm2'],
                        v29AccountContext: ordinal === 3 ? 'uncertain' : 'personal',
                    },
                }),
                feature: async ({ ordinal }) => ({
                    outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 1,
                    value: ordinal === 4
                        ? featureResult('personal', 'verified_female')
                        : featureResult(ordinal === 5 ? 'uncertain' : 'personal', 'unresolved'),
                }),
                resolveGender: async ({ ordinal }) => [1, 3, 5].includes(ordinal)
                    ? { outcome: 'capacity_skipped' as const, attempts: 0, retries: 0, elapsedMs: 0 }
                    : {
                        outcome: 'ok' as const, attempts: 1, retries: 0, elapsedMs: 1,
                        value: {
                            assessment: { inferredGender: 'female' as const, confidence: 'high' as const, ownerConsistency: 'same_person' as const, evidenceSelectionIds: ['m1', 'm2'] },
                            analyzedSelectionIds: ['m1', 'm2'],
                        },
                    },
            }),
        });

        expect(report.genderQuality?.headroom).toEqual({
            finalUnknownWithResolverMediaAtLeast2: 4,
            highBinaryFeatureUnresolvedPersonalOrIndividualCreatorWithResolverMediaAtLeast2: 1,
            featureUnresolvedWithUncertainAccountContext: 1,
            capacitySkippedFinalUnknown: 3,
            earlyResolverReadyFeatureFinalKnown: 1,
        });
        const headroom = report.genderQuality!.headroom;
        const featureUnresolved =
            (report.genderQuality!.feature.finalDecision.unresolved ?? 0)
            + (report.genderQuality!.feature.finalDecision.unresolved_stage_conflict ?? 0);
        expect(headroom.capacitySkippedFinalUnknown)
            .toBeLessThanOrEqual(report.resolver.capacitySkipped);
        expect(headroom.earlyResolverReadyFeatureFinalKnown)
            .toBeLessThanOrEqual(report.resolver.ready);
        expect(headroom.highBinaryFeatureUnresolvedPersonalOrIndividualCreatorWithResolverMediaAtLeast2)
            .toBeLessThanOrEqual(headroom.finalUnknownWithResolverMediaAtLeast2);
        expect(headroom.highBinaryFeatureUnresolvedPersonalOrIndividualCreatorWithResolverMediaAtLeast2)
            .toBeLessThanOrEqual(featureUnresolved);
        expect(headroom.featureUnresolvedWithUncertainAccountContext)
            .toBeLessThanOrEqual(featureUnresolved);
        expect(report.stages.genderResolution.calls).toBe(1);
        const safe = JSON.parse(lines[0]!);
        expect(safe.gender_quality.headroom).toEqual(report.genderQuality?.headroom);
        expect(Object.keys(safe.gender_quality.headroom)).toHaveLength(5);
        expect(JSON.stringify(safe)).not.toContain('candidate-');
        expect(JSON.stringify(safe)).not.toContain('m1');
        expect(JSON.stringify(safe)).not.toContain('형식 검증');
    });

    it('counts every final unknown with selected resolver media once across non-ok and official terminals', async () => {
        const evaluationPolicy = {
            capability: 'historical-official-e2e-standard-v27-risk-v23-to-ai-v212-gender-quality' as const,
            aiStage: 'ai-stage-policy-v2.12' as const,
        };
        const v212Bundle = {
            ...bundle,
            capture: {
                ...bundle.capture,
                sourceLineage: {
                    selectedPlanId: 'standard' as const,
                    policyVersions: {
                        pipeline: 'v2' as const,
                        aiStage: 'ai-stage-policy-v2.7' as const,
                        risk: 'risk-policy-v2.3' as const,
                    },
                },
                evaluationPolicy,
            },
            profiles: [
                {
                    ...bundle.profiles[0]!,
                    ordinal: 1,
                    username: 'non-ok-terminal',
                },
                {
                    ...bundle.profiles[0]!,
                    ordinal: 2,
                    username: 'official-terminal',
                    fullName: 'Official Studio',
                    bio: 'New single out now',
                },
            ],
        };
        const feature = vi.fn();
        const resolveGender = vi.fn();

        const report = await runAnalysisV2AiReplay({
            bundle: v212Bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy,
            runner: v212Runner({
                triage: async ({ ordinal }) => ordinal === 1
                    ? { outcome: 'failed' as const, attempts: 0, retries: 0, elapsedMs: 0 }
                    : {
                        outcome: 'ok' as const, attempts: 1, retries: 0, elapsedMs: 1,
                        value: {
                            assessment: { inferredGender: 'unknown' as const, confidence: 'low' as const, ownerConsistency: 'multiple_or_unclear' as const, evidenceSelectionIds: ['m1'] },
                            routingDecision: 'route_to_feature_analysis' as const,
                            routingReason: 'conserve_female_recall' as const,
                            analyzedSelectionIds: ['m1', 'm2'],
                            v29AccountContext: 'official_group_or_brand' as const,
                        },
                    },
                feature,
                resolveGender,
            }),
        });

        expect(feature).not.toHaveBeenCalled();
        expect(resolveGender).not.toHaveBeenCalled();
        expect(report.gender).toEqual({ male: 0, female: 0, unknown: 2, unknownRate: 1 });
        expect(report.genderQuality?.headroom.finalUnknownWithResolverMediaAtLeast2)
            .toBe(report.gender.unknown);
    });

    it('runs the full eligible v2.13 shadow cohort once after preserving the v2.12 control', async () => {
        const evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v213-feature-high-resolution-shadow' as const,
            aiStage: 'ai-stage-policy-v2.13' as const,
        };
        const profiles = Array.from({ length: 8 }, (_, index) => {
            const ordinal = index + 1;
            const mediaCount = ordinal === 6 ? 1 : 2;
            const media = Array.from({ length: mediaCount }, (_, mediaIndex) => ({
                selectionId: `candidate-${ordinal}-media-${mediaIndex + 1}`,
                kind: 'feed' as const,
                postId: `candidate-${ordinal}-post-${mediaIndex + 1}`,
                caption: null,
                jpegBase64: '/9j/2Q==',
            }));
            return {
                ...bundle.profiles[0]!,
                ordinal,
                username: `sensitive_candidate_${ordinal}`,
                fullName: null,
                bio: null,
                media,
                triageSelectionIds: media.map(item => item.selectionId),
                featureSelectionIds: media.map(item => item.selectionId),
                resolverSelectionIds: media.map(item => item.selectionId),
                coverage: {
                    selectedCount: media.length,
                    normalizedCount: media.length,
                    failures: [],
                },
            };
        });
        const privateProfiles = Array.from({ length: 41 }, (_, index) => ({
            ...bundle.profiles[1]!,
            ordinal: index + 9,
            username: `private_${index + 9}`,
        }));
        const sourceIdentities = [
            ...profiles.map(profile => ({
                ordinal: profile.ordinal,
                username: profile.username,
                partition: 'public' as const,
            })),
            ...privateProfiles.map(profile => ({
                ordinal: profile.ordinal,
                username: profile.username,
                partition: 'private' as const,
            })),
            {
                ordinal: 50,
                username: 'sensitive_missing_candidate',
                partition: 'fetch_terminal' as const,
            },
        ];
        const v213Bundle = {
            ...bundle,
            schemaVersion: 2 as const,
            capture: {
                ...bundle.capture,
                scope: 'ai-only-historical-partial-available' as const,
                notExact: true as const,
                fullE2eEvidence: false as const,
                noMediaSubstitution: true as const,
                sourceLineage: {
                    selectedPlanId: 'standard' as const,
                    policyVersions: {
                        pipeline: 'v2' as const,
                        aiStage: 'ai-stage-policy-v2.7' as const,
                        risk: 'risk-policy-v2.3' as const,
                    },
                },
                evaluationPolicy,
                partial: {
                    sourceUniverseDigest:
                        historicalPartialSourceUniverseDigest(sourceIdentities),
                    sourceIdentities,
                    mediaUnavailable: [],
                },
            },
            profiles: [...profiles, ...privateProfiles],
        } satisfies AnalysisV2ReplayBundle;
        const featureResult = (
            gender: 'female' | 'male' | 'unknown',
            finalGenderDecision: FeatureAnalysisResult['finalGenderDecision'],
            accountContext:
                | 'personal'
                | 'individual_creator'
                | 'official_group_or_brand'
                | 'uncertain' = 'personal',
        ): FeatureAnalysisResult => ({
            features: {
                gender,
                genderConfidence: gender === 'unknown' ? 'low' : 'high',
                ownerConsistency: gender === 'unknown'
                    ? 'multiple_or_unclear'
                    : 'same_person',
                appearanceGrade: 1,
                exposureScore: 0,
                businessClassification: 'uncertain',
                businessConfidence: 'low',
                accountContext,
                marriageEvidence: 'none',
                partnerEvidence: 'none',
                partnerExclusionContext: 'none',
                evidenceSelectionIds: {
                    gender: gender === 'unknown'
                        ? []
                        : ['candidate-2-media-1', 'candidate-2-media-2'],
                    appearance: [],
                    exposure: [],
                    business: [],
                    accountContext: ['candidate-2-media-1'],
                    marriagePartner: [],
                },
                oneLineOverview: '고정된 공개 자료를 근거로 만든 충분히 긴 테스트용 계정 요약입니다.',
            },
            finalGenderDecision,
            analyzedSelectionIds: ['candidate-2-media-1', 'candidate-2-media-2'],
        });
        const controlFeatureOrdinals: number[] = [];
        const resolverOrdinals: number[] = [];
        const shadowOrdinals: number[] = [];
        const lines: string[] = [];
        const report = await runAnalysisV2AiReplay({
            bundle: v213Bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy,
            diagnosticPartialCoverageCapability:
                diagnosticPartialCoverageCapability('ai-stage-policy-v2.13'),
            write: line => lines.push(line),
            runner: v213Runner({
                triage: async ({ ordinal, media }) => ordinal === 8
                    ? {
                        outcome: 'failed' as const,
                        calls: 0,
                        attempts: 0,
                        retries: 0,
                        elapsedMs: 0,
                    }
                    : {
                        outcome: 'ok' as const,
                        calls: 1,
                        attempts: 1,
                        retries: 0,
                        elapsedMs: 1,
                        value: {
                            assessment: {
                                inferredGender: 'unknown' as const,
                                confidence: 'low' as const,
                                ownerConsistency: 'multiple_or_unclear' as const,
                                evidenceSelectionIds: [media[0]!.selectionId],
                            },
                            routingDecision: 'route_to_feature_analysis' as const,
                            routingReason: 'conserve_female_recall' as const,
                            analyzedSelectionIds: media.map(item => item.selectionId),
                            v29AccountContext: 'personal' as const,
                        },
                    },
                feature: async ({ ordinal }) => {
                    controlFeatureOrdinals.push(ordinal);
                    if (ordinal === 7) {
                        return {
                            outcome: 'rejected' as const,
                            calls: 1,
                            attempts: 1,
                            retries: 0,
                            elapsedMs: 2,
                            failureDisposition: { rejected: 1 },
                        };
                    }
                    return {
                        outcome: 'ok',
                        calls: 1,
                        attempts: 1,
                        retries: 0,
                        elapsedMs: 2,
                        value: ordinal === 1
                            ? featureResult('female', 'verified_female')
                            : featureResult(
                                'unknown',
                                'unresolved',
                                ordinal === 4
                                    ? 'uncertain'
                                    : ordinal === 5
                                        ? 'official_group_or_brand'
                                        : 'personal',
                            ),
                    };
                },
                resolveGender: async ({ ordinal }) => {
                    resolverOrdinals.push(ordinal);
                    return {
                        outcome: 'capacity_skipped',
                        calls: 0,
                        attempts: 0,
                        retries: 0,
                        elapsedMs: 0,
                    };
                },
                shadowFeature: async ({ ordinal }) => {
                    expect(controlFeatureOrdinals.sort((a, b) => a - b))
                        .toEqual([1, 2, 3, 4, 5, 6, 7]);
                    expect(resolverOrdinals.sort((a, b) => a - b))
                        .toEqual([1, 2, 3, 4, 5, 7]);
                    shadowOrdinals.push(ordinal);
                    if (ordinal === 7) {
                        return {
                            outcome: 'failed',
                            calls: 1,
                            attempts: 1,
                            retries: 0,
                            elapsedMs: 7,
                            failureDisposition: { response_rejected: 1 },
                            failureKind: { http_4xx: 1 },
                        };
                    }
                    return {
                        outcome: 'ok',
                        calls: 1,
                        attempts: 1,
                        retries: 0,
                        elapsedMs: ordinal,
                        value: ordinal === 2
                            ? featureResult('female', 'verified_female')
                            : ordinal === 3
                                ? featureResult('male', 'verified_non_female')
                                : featureResult(
                                    'female',
                                    'verified_female',
                                    'uncertain',
                                ),
                    };
                },
            } as ReplayAiRunner & {
                shadowFeature: NonNullable<ReplayAiRunner['feature']>;
            }),
        });

        expect(shadowOrdinals.sort((a, b) => a - b)).toEqual([2, 3, 4, 7]);
        expect(report.gender).toEqual({
            male: 1,
            female: 2,
            unknown: 5,
            unknownRate: 0.625,
        });
        expect(report.stages.featureAnalysis).toMatchObject({ calls: 7 });
        expect((report.stages as Record<string, unknown>).featureAnalysisShadowRescue)
            .toMatchObject({
                calls: 4,
                failureDisposition: { response_rejected: 1 },
                failureKind: { http_4xx: 1 },
            });
        expect((report.genderQuality as {
            shadowRescue: unknown;
        }).shadowRescue).toEqual({
            baselineMale: 0,
            baselineFemale: 1,
            baselineUnknown: 7,
            officialOrGroupExcluded: 1,
            insufficientMedia: 1,
            controlUnavailable: 1,
            eligible: 4,
            attempted: 4,
            rescuedMale: 1,
            rescuedFemale: 1,
            unresolved: 1,
            providerNonOk: {
                rateLimited: 0,
                retryExhausted: 0,
                rejected: 0,
                failed: 1,
                capacitySkipped: 0,
            },
            finalMale: 1,
            finalFemale: 2,
            finalUnknown: 5,
            missingPublic: 1,
        });
        expect(report.genderQuality?.headroom.finalUnknownWithResolverMediaAtLeast2)
            .toBe(6);
        expect(report.genderQuality?.qualityGate.observedUnknownRate).toBe(0.625);
        expect(report.genderQuality?.qualityGate).toMatchObject({
            worstCaseUnknownRate: 0.6667,
            worstCasePass: false,
        });
        const safe = JSON.parse(lines[0]!);
        expect(safe.gender_quality.shadow_rescue)
            .toEqual((report.genderQuality as {
                shadowRescue: unknown;
            }).shadowRescue);
        expect(JSON.stringify(safe)).not.toMatch(
            /sensitive_candidate|candidate-[0-9]+-media/,
        );
    });

    it('expands only the v2.16 shadow to exact single-profile candidates with cohort conservation', async () => {
        const evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v216-single-profile-admission-shadow' as const,
            aiStage: 'ai-stage-policy-v2.16' as const,
        };
        const candidate = (
            ordinal: number,
            kinds: readonly ('profile' | 'feed')[],
        ) => {
            const media = kinds.map((kind, index) => ({
                selectionId: `v216-${ordinal}-${kind}-${index + 1}`,
                kind,
                ...(kind === 'feed'
                    ? { postId: `v216-${ordinal}-post-${index + 1}` }
                    : {}),
                caption: null,
                jpegBase64: '/9j/2Q==',
            }));
            return {
                ...bundle.profiles[0]!,
                ordinal,
                username: `sensitive_v216_candidate_${ordinal}`,
                fullName: null,
                hasProfileImage: kinds.includes('profile'),
                bio: null,
                media,
                triageSelectionIds: media.map(item => item.selectionId),
                featureSelectionIds: media.map(item => item.selectionId),
                resolverSelectionIds: media.map(item => item.selectionId),
                coverage: {
                    selectedCount: media.length,
                    normalizedCount: media.length,
                    failures: [],
                },
            };
        };
        const publicProfiles = [
            candidate(1, ['feed', 'feed']),
            candidate(2, ['profile']),
            candidate(3, ['profile']),
            candidate(4, ['profile']),
            candidate(5, ['profile']),
            candidate(6, ['profile']),
            candidate(7, ['feed']),
        ];
        const privateProfiles = Array.from({ length: 42 }, (_, index) => ({
            ...bundle.profiles[1]!,
            ordinal: index + 8,
            username: `private_v216_${index + 8}`,
        }));
        const sourceIdentities = [
            ...publicProfiles.map(profile => ({
                ordinal: profile.ordinal,
                username: profile.username,
                partition: 'public' as const,
            })),
            ...privateProfiles.map(profile => ({
                ordinal: profile.ordinal,
                username: profile.username,
                partition: 'private' as const,
            })),
            {
                ordinal: 50,
                username: 'sensitive_v216_missing',
                partition: 'fetch_terminal' as const,
            },
        ];
        const v216Bundle = {
            ...bundle,
            schemaVersion: 2 as const,
            capture: {
                ...bundle.capture,
                scope: 'ai-only-historical-partial-available' as const,
                notExact: true as const,
                fullE2eEvidence: false as const,
                noMediaSubstitution: true as const,
                sourceLineage: {
                    selectedPlanId: 'standard' as const,
                    policyVersions: {
                        pipeline: 'v2' as const,
                        aiStage: 'ai-stage-policy-v2.7' as const,
                        risk: 'risk-policy-v2.3' as const,
                    },
                },
                evaluationPolicy,
                partial: {
                    sourceUniverseDigest:
                        historicalPartialSourceUniverseDigest(sourceIdentities),
                    sourceIdentities,
                    mediaUnavailable: [],
                },
            },
            profiles: [...publicProfiles, ...privateProfiles],
        } satisfies AnalysisV2ReplayBundle;
        const featureResult = (
            finalGenderDecision: FeatureAnalysisResult['finalGenderDecision'],
            accountContext:
                | 'personal'
                | 'individual_creator'
                | 'official_group_or_brand'
                | 'uncertain',
        ): FeatureAnalysisResult => ({
            features: {
                gender: finalGenderDecision === 'verified_female'
                    ? 'female'
                    : finalGenderDecision === 'verified_non_female'
                        ? 'male'
                        : 'unknown',
                genderConfidence: finalGenderDecision === 'unresolved'
                    ? 'low'
                    : 'high',
                ownerConsistency: finalGenderDecision === 'unresolved'
                    ? 'multiple_or_unclear'
                    : 'same_person',
                appearanceGrade: 1,
                exposureScore: 0,
                businessClassification: 'uncertain',
                businessConfidence: 'low',
                accountContext,
                marriageEvidence: 'none',
                partnerEvidence: 'none',
                partnerExclusionContext: 'none',
                evidenceSelectionIds: {
                    gender: [],
                    appearance: [],
                    exposure: [],
                    business: [],
                    accountContext: [],
                    marriagePartner: [],
                },
                oneLineOverview:
                    '고정된 공개 자료를 근거로 만든 충분히 긴 테스트용 계정 요약입니다.',
            },
            finalGenderDecision,
            analyzedSelectionIds: [],
        });
        const shadowOrdinals: number[] = [];
        const lines: string[] = [];
        const report = await runAnalysisV2AiReplay({
            bundle: v216Bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy,
            diagnosticPartialCoverageCapability:
                diagnosticPartialCoverageCapability('ai-stage-policy-v2.16'),
            write: line => lines.push(line),
            runner: v216Runner({
                triage: async ({ media }) => ({
                    outcome: 'ok',
                    calls: 1,
                    attempts: 1,
                    retries: 0,
                    elapsedMs: 1,
                    value: {
                        assessment: {
                            inferredGender: 'unknown',
                            confidence: 'low',
                            ownerConsistency: 'multiple_or_unclear',
                            evidenceSelectionIds: media.map(
                                item => item.selectionId,
                            ),
                        },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: media.map(
                            item => item.selectionId,
                        ),
                        v29AccountContext: 'personal',
                    },
                }),
                feature: async () => ({
                    outcome: 'ok',
                    calls: 1,
                    attempts: 1,
                    retries: 0,
                    elapsedMs: 1,
                    value: featureResult('unresolved', 'personal'),
                }),
                resolveGender: async () => ({
                    outcome: 'capacity_skipped',
                    calls: 0,
                    attempts: 0,
                    retries: 0,
                    elapsedMs: 0,
                }),
                shadowFeature: async ({ ordinal, media }) => {
                    shadowOrdinals.push(ordinal);
                    if (ordinal >= 2 && ordinal <= 6) {
                        expect(media).toHaveLength(1);
                        expect(media[0]?.kind).toBe('profile');
                    }
                    if (ordinal === 6) {
                        return {
                            outcome: 'failed',
                            calls: 1,
                            attempts: 1,
                            retries: 0,
                            elapsedMs: 1,
                            failureDisposition: { response_rejected: 1 },
                        };
                    }
                    const result = ordinal === 1 || ordinal === 3
                        ? featureResult('verified_female', 'personal')
                        : ordinal === 2
                            ? featureResult(
                                'verified_non_female',
                                'individual_creator',
                            )
                            : ordinal === 4
                                ? featureResult(
                                    'verified_female',
                                    'official_group_or_brand',
                                )
                                : featureResult(
                                    'verified_female',
                                    'uncertain',
                                );
                    return {
                        outcome: 'ok',
                        calls: 1,
                        attempts: 1,
                        retries: 0,
                        elapsedMs: 1,
                        value: result,
                    };
                },
            }),
        });

        expect(shadowOrdinals.sort((a, b) => a - b))
            .toEqual([1, 2, 3, 4, 5, 6]);
        expect(report.gender).toEqual({
            male: 1,
            female: 2,
            unknown: 4,
            unknownRate: 0.5714,
        });
        expect(report.genderQuality?.shadowRescue).toMatchObject({
            baselineMale: 0,
            baselineFemale: 0,
            baselineUnknown: 7,
            officialOrGroupExcluded: 0,
            insufficientMedia: 1,
            controlUnavailable: 0,
            eligible: 6,
            attempted: 6,
            rescuedMale: 1,
            rescuedFemale: 2,
            unresolved: 2,
            providerNonOk: {
                rateLimited: 0,
                retryExhausted: 0,
                rejected: 0,
                failed: 1,
                capacitySkipped: 0,
            },
            finalMale: 1,
            finalFemale: 2,
            finalUnknown: 4,
            admissionCohorts: {
                resolverMediaAtLeast2: {
                    eligible: 1,
                    attempted: 1,
                    rescuedMale: 0,
                    rescuedFemale: 1,
                    unresolved: 0,
                    providerNonOk: {
                        rateLimited: 0,
                        retryExhausted: 0,
                        rejected: 0,
                        failed: 0,
                        capacitySkipped: 0,
                    },
                },
                singleProfileOnly: {
                    eligible: 5,
                    attempted: 5,
                    rescuedMale: 1,
                    rescuedFemale: 1,
                    unresolved: 2,
                    providerNonOk: {
                        rateLimited: 0,
                        retryExhausted: 0,
                        rejected: 0,
                        failed: 1,
                        capacitySkipped: 0,
                    },
                },
            },
        });
        expect(report.genderQuality?.qualityGate).toMatchObject({
            observedUnknownRate: 0.5714,
            worstCaseUnknownRate: 0.625,
            observedPass: false,
            worstCasePass: false,
        });
        const safe = JSON.parse(lines[0]!);
        expect(safe.gender_quality.shadow_rescue.admissionCohorts)
            .toEqual(report.genderQuality?.shadowRescue?.admissionCohorts);
        expect(JSON.stringify(safe)).not.toMatch(
            /sensitive_v216|v216-[0-9]+-/,
        );
    });

    it('classifies only exact profile-one media as the v2.16 expanded cohort', () => {
        expect(replayFeatureShadowAdmissionCohort(
            'ai-stage-policy-v2.15',
            [{ kind: 'profile' }],
        )).toBeNull();
        expect(replayFeatureShadowAdmissionCohort(
            'ai-stage-policy-v2.16',
            [],
        )).toBeNull();
        expect(replayFeatureShadowAdmissionCohort(
            'ai-stage-policy-v2.16',
            [{ kind: 'feed' }],
        )).toBeNull();
        expect(replayFeatureShadowAdmissionCohort(
            'ai-stage-policy-v2.16',
            [{ kind: 'profile' }],
        )).toBe('single_profile_only');
        expect(replayFeatureShadowAdmissionCohort(
            'ai-stage-policy-v2.16',
            [{ kind: 'feed' }, { kind: 'feed' }],
        )).toBe('resolver_media_at_least_2');
    });

    it('fails closed before control work when the authenticated v2.13 runner lacks shadow feature', async () => {
        const evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v213-feature-high-resolution-shadow' as const,
            aiStage: 'ai-stage-policy-v2.13' as const,
        };
        const partial = validPartialBundle();
        const v213Bundle = {
            ...partial,
            capture: {
                ...partial.capture,
                evaluationPolicy,
            },
        } satisfies AnalysisV2ReplayBundle;
        const triage = vi.fn();

        await expect(runAnalysisV2AiReplay({
            bundle: v213Bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy,
            diagnosticPartialCoverageCapability:
                diagnosticPartialCoverageCapability('ai-stage-policy-v2.13'),
            runner: v213Runner({ triage }),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_V213_SHADOW_RUNNER_REQUIRED');
        expect(triage).not.toHaveBeenCalled();
    });

    it('fails closed before control work when the authenticated v2.15 runner lacks shadow feature', async () => {
        const evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v215-feature-output-cap-shadow' as const,
            aiStage: 'ai-stage-policy-v2.15' as const,
        };
        const partial = validPartialBundle();
        const v215Bundle = {
            ...partial,
            capture: {
                ...partial.capture,
                evaluationPolicy,
            },
        } satisfies AnalysisV2ReplayBundle;
        const triage = vi.fn();

        await expect(runAnalysisV2AiReplay({
            bundle: v215Bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy,
            diagnosticPartialCoverageCapability:
                diagnosticPartialCoverageCapability('ai-stage-policy-v2.15'),
            runner: v215Runner({ triage }),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_V215_SHADOW_RUNNER_REQUIRED');
        expect(triage).not.toHaveBeenCalled();
    });

    it('runs the v2.9 resolver for an ambiguous personal account without admitting feature', async () => {
        const feature = vi.fn();
        const resolveGender = vi.fn(async () => ({
            outcome: 'ok' as const,
            attempts: 1,
            retries: 0,
            elapsedMs: 3,
            value: {
                assessment: {
                    inferredGender: 'female' as const,
                    confidence: 'high' as const,
                    ownerConsistency: 'same_person' as const,
                    evidenceSelectionIds: ['m1', 'm2'],
                },
                analyzedSelectionIds: ['m1', 'm2'],
            },
        }));
        const report = await runAnalysisV2AiReplay({
            bundle: {
                ...bundle,
                capture: {
                    ...bundle.capture,
                    sourceLineage: {
                        ...bundle.capture.sourceLineage,
                        policyVersions: {
                            ...bundle.capture.sourceLineage.policyVersions,
                            aiStage: 'ai-stage-policy-v2.9',
                            scheduler: 'ai-scheduler-v1',
                        },
                    },
                },
            },
            mode: 'paid-ai',
            paidAiOptIn: true,
            runner: v29Runner({
                triage: async () => ({
                    outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 1,
                    value: {
                        assessment: {
                            inferredGender: 'unknown',
                            confidence: 'low',
                            ownerConsistency: 'multiple_or_unclear',
                            evidenceSelectionIds: ['m1'],
                        },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: ['m1', 'm2'],
                        v29AccountContext: 'personal',
                    },
                }),
                feature,
                resolveGender,
            }),
        });

        expect(feature).not.toHaveBeenCalled();
        expect(resolveGender).toHaveBeenCalledOnce();
        expect(report.gender).toEqual({ male: 0, female: 1, unknown: 0, unknownRate: 0 });
        expect(report.resolver).toMatchObject({
            ready: 1, applied: 1, inconclusive: 0, cutoff: 0, capacitySkipped: 0,
            admission: {
                eligible: 1,
                alreadyVerified: 0,
                officialOrGroup: 0,
                uncertainOrAbsent: 0,
                insufficientMedia: 0,
            },
            outcomes: {
                readyHighConfirmed: 1,
                evidenceInsufficient: 0,
                mixed: 0,
                unknown: 0,
                reconciliationApplied: 1,
                reconciliationInconclusive: 0,
                cutoff: 0,
                capacitySkipped: 0,
            },
        });
    });

    it('counts a verified-looking official account as official rather than already verified', async () => {
        const feature = vi.fn();
        const resolveGender = vi.fn();
        const report = await runAnalysisV2AiReplay({
            bundle: {
                ...bundle,
                capture: {
                    ...bundle.capture,
                    sourceLineage: {
                        ...bundle.capture.sourceLineage,
                        policyVersions: {
                            ...bundle.capture.sourceLineage.policyVersions,
                            aiStage: 'ai-stage-policy-v2.9',
                            scheduler: 'ai-scheduler-v1',
                        },
                    },
                },
            },
            mode: 'paid-ai',
            paidAiOptIn: true,
            runner: v29Runner({
                triage: async () => ({
                    outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 1,
                    value: {
                        assessment: {
                            inferredGender: 'female',
                            confidence: 'high',
                            ownerConsistency: 'same_person',
                            evidenceSelectionIds: ['m1', 'm2'],
                        },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: ['m1', 'm2'],
                        v29AccountContext: 'official_group_or_brand',
                    },
                }),
                feature,
                resolveGender,
            }),
        });

        expect(feature).not.toHaveBeenCalled();
        expect(resolveGender).not.toHaveBeenCalled();
        expect(report.resolver.admission).toEqual({
            eligible: 0,
            alreadyVerified: 0,
            officialOrGroup: 1,
            uncertainOrAbsent: 0,
            insufficientMedia: 0,
        });
    });

    it('caps concurrently active public profiles at four', async () => {
        let active = 0;
        let maximum = 0;
        const releases: Array<() => void> = [];
        const publicProfiles = Array.from({ length: 5 }, (_, index) => ({
            ...bundle.profiles[0]!,
            ordinal: index + 1,
            username: `public${index}`,
        }));
        const pending = runAnalysisV2AiReplay({
            bundle: { ...bundle, profiles: publicProfiles },
            mode: 'paid-ai',
            paidAiOptIn: true,
            runner: v27Runner({
                triage: async () => {
                    active++;
                    maximum = Math.max(maximum, active);
                    await new Promise<void>(resolve => releases.push(resolve));
                    active--;
                    return {
                        outcome: 'ok',
                        attempts: 1,
                        retries: 0,
                        elapsedMs: 1,
                        value: {
                            assessment: {
                                inferredGender: 'male',
                                confidence: 'high',
                                ownerConsistency: 'same_person',
                                evidenceSelectionIds: ['m1'],
                            },
                            routingDecision: 'exclude_high_confidence_male',
                            routingReason: 'high_confidence_same_owner_male',
                            analyzedSelectionIds: ['m1', 'm2'],
                        },
                    };
                },
            }),
        });

        await vi.waitFor(() => expect(releases).toHaveLength(4));
        expect(maximum).toBe(4);
        releases.splice(0, 4).forEach(release => release());
        await vi.waitFor(() => expect(releases).toHaveLength(1));
        releases.splice(0).forEach(release => release());
        await expect(pending).resolves.toMatchObject({
            gender: { male: 5, female: 0, unknown: 0 },
        });
        expect(maximum).toBe(4);
    });

    it('runs the private-name batch alongside public profile AI work', async () => {
        let privateStarted = false;
        let releasePrivate: (() => void) | undefined;
        const privateNames = vi.fn(async () => {
            privateStarted = true;
            await new Promise<void>(resolve => {
                releasePrivate = resolve;
            });
            return { outcome: 'ok' as const, calls: 1, attempts: 1, retries: 0, elapsedMs: 1 };
        });
        const triage = vi.fn(async () => {
            expect(privateStarted).toBe(true);
            releasePrivate?.();
            return {
                outcome: 'ok' as const,
                attempts: 1,
                retries: 0,
                elapsedMs: 1,
                value: {
                    assessment: {
                        inferredGender: 'male' as const,
                        confidence: 'high' as const,
                        ownerConsistency: 'same_person' as const,
                        evidenceSelectionIds: ['m1'],
                    },
                    routingDecision: 'exclude_high_confidence_male' as const,
                    routingReason: 'high_confidence_same_owner_male' as const,
                    analyzedSelectionIds: ['m1', 'm2'],
                },
            };
        });

        await runAnalysisV2AiReplay({
            bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            runner: v27Runner({ privateNames, triage }),
        });
        expect(privateNames).toHaveBeenCalledOnce();
        expect(triage).toHaveBeenCalledOnce();
    });

    it('cuts off an opportunistic resolver without blocking the required result', async () => {
        let aborted = false;
        const report = await runAnalysisV2AiReplay({
            bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            resolverCutoffMs: 1,
            runner: v27Runner({
                triage: async () => ({
                    outcome: 'ok',
                    attempts: 1,
                    retries: 0,
                    elapsedMs: 1,
                    value: {
                        assessment: {
                            inferredGender: 'unknown',
                            confidence: 'low',
                            ownerConsistency: 'multiple_or_unclear',
                            evidenceSelectionIds: ['m1'],
                        },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: ['m1', 'm2'],
                    },
                }),
                feature: async () => ({
                    outcome: 'failed',
                    attempts: 1,
                    retries: 0,
                    elapsedMs: 1,
                }),
                resolveGender: async ({
                    signal,
                    onAttemptStart,
                    onProviderDispatch,
                    onAttemptTelemetry,
                }) => new Promise(resolve => {
                    onAttemptStart?.({ attempt: 1, retryCount: 0 });
                    onProviderDispatch?.({ attempt: 1, retryCount: 0 });
                    onAttemptTelemetry?.({
                        attempt: 1,
                        retryCount: 0,
                        disposition: 'rate_limited',
                        latencyMs: 5,
                    });
                    onAttemptStart?.({ attempt: 2, retryCount: 1 });
                    onProviderDispatch?.({ attempt: 2, retryCount: 1 });
                    signal.addEventListener('abort', () => {
                        aborted = true;
                        setTimeout(() => resolve({
                            outcome: 'failed', attempts: 1, retries: 0, elapsedMs: 20,
                        }), 20);
                    }, { once: true });
                }),
            }),
        });

        expect(aborted).toBe(true);
        expect(report.resolver).toMatchObject({ cutoff: 1, applied: 0 });
        expect(report.stages.genderResolution).toMatchObject({
            calls: 2,
            retries: 1,
            rateLimited: 1,
            failureDisposition: { rate_limited: 1, cutoff: 1 },
        });
        expect(report.stages.genderResolution.meanLatencyMs).toBeGreaterThanOrEqual(3);
        expect(report.gender).toEqual({ male: 0, female: 0, unknown: 1, unknownRate: 1 });
    });

    it('marks retry-backoff cutoff without fabricating an attempt or latency', async () => {
        const report = await runAnalysisV2AiReplay({
            bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            resolverCutoffMs: 1,
            runner: v27Runner({
                triage: async () => ({
                    outcome: 'ok',
                    attempts: 1,
                    retries: 0,
                    elapsedMs: 1,
                    value: {
                        assessment: {
                            inferredGender: 'unknown',
                            confidence: 'low',
                            ownerConsistency: 'multiple_or_unclear',
                            evidenceSelectionIds: ['m1'],
                        },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: ['m1', 'm2'],
                    },
                }),
                feature: async () => ({
                    outcome: 'failed',
                    attempts: 1,
                    retries: 0,
                    elapsedMs: 1,
                }),
                resolveGender: async ({
                    signal,
                    onAttemptStart,
                    onProviderDispatch,
                    onAttemptTelemetry,
                }) => new Promise(resolve => {
                    onAttemptStart?.({ attempt: 1, retryCount: 0 });
                    onProviderDispatch?.({ attempt: 1, retryCount: 0 });
                    onAttemptTelemetry?.({
                        attempt: 1,
                        retryCount: 0,
                        disposition: 'rate_limited',
                        latencyMs: 5,
                    });
                    signal.addEventListener('abort', () => {
                        resolve({
                            outcome: 'failed',
                            attempts: 1,
                            retries: 0,
                            elapsedMs: 5,
                        });
                    }, { once: true });
                }),
            }),
        });

        expect(report.resolver).toMatchObject({ cutoff: 1, applied: 0 });
        expect(report.stages.genderResolution).toMatchObject({
            calls: 1,
            retries: 0,
            rateLimited: 1,
            meanLatencyMs: 5,
            failureDisposition: {
                rate_limited: 1,
                backoff_cutoff: 1,
            },
        });
        expect(report.stages.genderResolution.failureDisposition.cutoff).toBeUndefined();
    });

    it('lets all required profile work finish before cutting off pending resolvers', async () => {
        const publicProfiles = Array.from({ length: 5 }, (_, index) => ({
            ...bundle.profiles[0]!,
            ordinal: index + 1,
            username: `candidate${index}`,
        }));
        let resolverStarts = 0;
        let everyRequiredProfileStartedBeforeAbort = true;
        const report = await runAnalysisV2AiReplay({
            bundle: { ...bundle, profiles: publicProfiles },
            mode: 'paid-ai',
            paidAiOptIn: true,
            resolverCutoffMs: 1,
            runner: v27Runner({
                triage: async () => ({
                    outcome: 'ok',
                    attempts: 1,
                    retries: 0,
                    elapsedMs: 1,
                    value: {
                        assessment: {
                            inferredGender: 'unknown',
                            confidence: 'low',
                            ownerConsistency: 'multiple_or_unclear',
                            evidenceSelectionIds: ['m1'],
                        },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: ['m1', 'm2'],
                    },
                }),
                feature: async () => ({
                    outcome: 'failed',
                    attempts: 1,
                    retries: 0,
                    elapsedMs: 1,
                }),
                resolveGender: async ({ signal }) => {
                    resolverStarts++;
                    return new Promise(resolve => {
                        signal.addEventListener('abort', () => {
                            if (resolverStarts !== publicProfiles.length) {
                                everyRequiredProfileStartedBeforeAbort = false;
                            }
                            resolve({
                                outcome: 'failed',
                                attempts: 0,
                                retries: 0,
                                elapsedMs: 1,
                            });
                        }, { once: true });
                    });
                },
            }),
        });

        expect(resolverStarts).toBe(5);
        expect(everyRequiredProfileStartedBeforeAbort).toBe(true);
        expect(report.resolver.cutoff).toBe(5);
        expect(report.gender.unknown).toBe(5);
    });

    it('aborts and observes a launched resolver when private-name work rejects', async () => {
        let rejectPrivate!: (error: Error) => void;
        let resolverSignal: AbortSignal | undefined;
        let resolverRejected = false;
        const privateNames = vi.fn(() => new Promise<never>((_, reject) => {
            rejectPrivate = reject;
        }));
        const resolveGender = vi.fn((input: Parameters<
            NonNullable<ReplayAiRunner['resolveGender']>
        >[0]) => new Promise<never>((_, reject) => {
            resolverSignal = input.signal;
            input.signal.addEventListener('abort', () => {
                resolverRejected = true;
                reject(new Error('resolver aborted'));
            }, { once: true });
        }));
        const pending = runAnalysisV2AiReplay({
            bundle,
            mode: 'paid-ai',
            paidAiOptIn: true,
            resolverCutoffMs: 10,
            runner: v27Runner({
                privateNames,
                triage: async () => ({
                    outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 1,
                    value: {
                        assessment: {
                            inferredGender: 'unknown',
                            confidence: 'low',
                            ownerConsistency: 'multiple_or_unclear',
                            evidenceSelectionIds: ['m1'],
                        },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: ['m1', 'm2'],
                    },
                }),
                feature: async () => ({
                    outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 1,
                    value: {
                        features: {
                            gender: 'unknown',
                            genderConfidence: 'low',
                            ownerConsistency: 'multiple_or_unclear',
                            appearanceGrade: 3,
                            exposureScore: 0,
                            businessClassification: 'uncertain',
                            businessConfidence: 'low',
                            accountContext: 'uncertain',
                            marriageEvidence: 'none',
                            partnerEvidence: 'none',
                            partnerExclusionContext: 'none',
                            evidenceSelectionIds: {
                                gender: [], appearance: [], exposure: [],
                                business: [], accountContext: [], marriagePartner: [],
                            },
                            oneLineOverview: '공개 단서가 부족해 계정 맥락을 확정하기 어렵습니다.',
                        },
                        finalGenderDecision: 'unresolved',
                        analyzedSelectionIds: ['m1', 'm2'],
                    },
                }),
                resolveGender,
            }),
        });

        await vi.waitFor(() => expect(resolveGender).toHaveBeenCalledOnce());
        rejectPrivate(new Error('private failed'));
        await expect(pending).rejects.toThrow('private failed');
        expect(resolverSignal?.aborted).toBe(true);
        expect(resolverRejected).toBe(true);
    });

    it('aborts and observes a launched resolver when feature work rejects', async () => {
        let rejectFeature!: (error: Error) => void;
        let resolverSignal: AbortSignal | undefined;
        let resolverRejected = false;
        const resolveGender = vi.fn((input: Parameters<
            NonNullable<ReplayAiRunner['resolveGender']>
        >[0]) => new Promise<never>((_, reject) => {
            resolverSignal = input.signal;
            input.signal.addEventListener('abort', () => {
                resolverRejected = true;
                reject(new Error('resolver aborted'));
            }, { once: true });
        }));
        const pending = runAnalysisV2AiReplay({
            bundle: { ...bundle, profiles: [bundle.profiles[0]!] },
            mode: 'paid-ai',
            paidAiOptIn: true,
            resolverCutoffMs: 10,
            runner: v27Runner({
                triage: async () => ({
                    outcome: 'ok', attempts: 1, retries: 0, elapsedMs: 1,
                    value: {
                        assessment: {
                            inferredGender: 'unknown',
                            confidence: 'low',
                            ownerConsistency: 'multiple_or_unclear',
                            evidenceSelectionIds: ['m1'],
                        },
                        routingDecision: 'route_to_feature_analysis',
                        routingReason: 'conserve_female_recall',
                        analyzedSelectionIds: ['m1', 'm2'],
                    },
                }),
                feature: () => new Promise<never>((_, reject) => {
                    rejectFeature = reject;
                }),
                resolveGender,
            }),
        });

        await vi.waitFor(() => expect(resolveGender).toHaveBeenCalledOnce());
        rejectFeature(new Error('feature failed'));
        await expect(pending).rejects.toThrow('feature failed');
        expect(resolverSignal?.aborted).toBe(true);
        expect(resolverRejected).toBe(true);
    });
});
