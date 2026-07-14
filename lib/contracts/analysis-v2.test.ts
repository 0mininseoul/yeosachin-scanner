import { describe, expect, it } from 'vitest';
import {
    analysisResultPageV1Schema,
    freshAdmissionErrorResponseV1Schema,
    preflightStatusV1Schema,
    progressSnapshotV1Schema,
    testEntitlementResponseV1Schema,
} from './analysis-v2';
import { encodeResultCursor } from '@/lib/domain/analysis/result-pagination';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const expiresAt = '2026-07-13T12:00:00.000Z';

describe('analysis V2 public contracts', () => {
    it('recovers only a strictly bound consumed preflight request', () => {
        expect(preflightStatusV1Schema.parse({
            schemaVersion: 1,
            preflightId: requestId,
            status: 'consumed',
            exclusionDecision: 'exclude',
            requestId,
        })).toEqual({
            schemaVersion: 1,
            preflightId: requestId,
            status: 'consumed',
            exclusionDecision: 'exclude',
            requestId,
        });
        expect(preflightStatusV1Schema.safeParse({
            schemaVersion: 1,
            preflightId: requestId,
            status: 'consumed',
            exclusionDecision: 'exclude',
        }).success).toBe(false);
        expect(preflightStatusV1Schema.safeParse({
            schemaVersion: 1,
            preflightId: requestId,
            status: 'consumed',
            requestId,
            targetInstagramId: 'raw.target',
        }).success).toBe(false);
    });

    it('strictly validates fresh admission plan snapshots before client use', () => {
        const latestPlan = {
            followersCount: 620,
            followingCount: 710,
            capacityRequiredPlanId: 'standard',
            requiredPlanId: 'standard',
            selectedPlanId: 'basic',
            pricingVersion: 'deferred',
            refreshedAt: '2026-07-14T12:00:00.000Z',
            plans: [
                {
                    planId: 'basic',
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 400, following: 400 },
                    detailedMutualLimit: 300,
                    selectionState: 'unavailable',
                    unavailableReason: 'below_required_plan',
                    pricingVersion: 'deferred',
                    price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
                {
                    planId: 'standard',
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 800, following: 800 },
                    detailedMutualLimit: 600,
                    selectionState: 'required',
                    unavailableReason: null,
                    pricingVersion: 'deferred',
                    price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
                {
                    planId: 'plus',
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 1_200, following: 1_200 },
                    detailedMutualLimit: 900,
                    selectionState: 'available_upgrade',
                    unavailableReason: null,
                    pricingVersion: 'deferred',
                    price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
            ],
        } as const;
        const response = {
            error: '최신 계정 정보로 분석 가능 여부를 확인할 수 없습니다.',
            code: 'ANALYSIS_V2_PLAN_NOT_ALLOWED',
            latestPlan,
        } as const;

        expect(freshAdmissionErrorResponseV1Schema.safeParse(response).success).toBe(true);
        expect(freshAdmissionErrorResponseV1Schema.safeParse({
            ...response,
            latestPlan: { ...latestPlan, rawProfile: { username: 'target' } },
        }).success).toBe(false);
        expect(freshAdmissionErrorResponseV1Schema.safeParse({
            ...response,
            latestPlan: {
                ...latestPlan,
                plans: latestPlan.plans.map((plan, index) => index === 1
                    ? { ...plan, pricingVersion: 'tampered' }
                    : plan),
            },
        }).success).toBe(false);
        expect(freshAdmissionErrorResponseV1Schema.safeParse({
            ...response,
            latestPlan: { ...latestPlan, requiredPlanId: null },
        }).success).toBe(false);
        expect(freshAdmissionErrorResponseV1Schema.safeParse({
            ...response,
            latestPlan: {
                ...latestPlan,
                plans: [latestPlan.plans[1], latestPlan.plans[0], latestPlan.plans[2]],
            },
        }).success).toBe(false);
    });

    it('distinguishes durable admission polling from an accepted analysis request', () => {
        expect(testEntitlementResponseV1Schema.parse({
            schemaVersion: 1,
            preflightId: requestId,
            status: 'admission_pending',
            backgroundProcessing: true,
            retryAfterMs: 1_000,
        })).toMatchObject({ status: 'admission_pending', retryAfterMs: 1_000 });

        expect(testEntitlementResponseV1Schema.parse({
            schemaVersion: 1,
            requestId,
            status: 'queued',
            backgroundProcessing: true,
        })).toMatchObject({ status: 'queued', requestId });

        expect(testEntitlementResponseV1Schema.safeParse({
            schemaVersion: 1,
            preflightId: requestId,
            status: 'admission_pending',
            backgroundProcessing: false,
            retryAfterMs: 1_000,
        }).success).toBe(false);
    });

    it('keeps every plan visible and identifies the required plan', () => {
        const result = preflightStatusV1Schema.parse({
            schemaVersion: 1,
            preflightId: requestId,
            expiresAt,
            status: 'ready',
            exclusionDecision: 'exclude',
            target: {
                username: 'Target.Name',
                fullName: null,
                bio: null,
                profileImage: '/api/image-proxy?token=signed',
                followersCount: 650,
                followingCount: 500,
                isPrivate: false,
            },
            accessMode: 'test_entitlement',
            capacityRequiredPlan: 'standard',
            requiredPlan: 'standard',
            pricingVersion: 'deferred',
            plans: [
                {
                    planId: 'basic',
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 400, following: 400 },
                    detailedMutualLimit: 300,
                    selectionState: 'unavailable',
                    unavailableReason: 'below_required_plan',
                    pricingVersion: 'deferred',
                    price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
                {
                    planId: 'standard',
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 800, following: 800 },
                    detailedMutualLimit: 600,
                    selectionState: 'required',
                    unavailableReason: null,
                    pricingVersion: 'deferred',
                    price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
                {
                    planId: 'plus',
                    launchStatus: 'disabled',
                    relationshipCapacity: { followers: 1_200, following: 1_200 },
                    detailedMutualLimit: 900,
                    selectionState: 'unavailable',
                    unavailableReason: 'launch_gate',
                    pricingVersion: 'deferred',
                    price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
            ],
        });

        expect(result.status).toBe('ready');
        if (result.status === 'ready') {
            expect(result.exclusionDecision).toBe('exclude');
            expect('excludedInstagramId' in result).toBe(false);
            expect(result.target.username).toBe('target.name');
            expect(result.plans).toHaveLength(3);
            expect(result.plans[2]).toMatchObject({
                launchStatus: 'disabled',
                selectionState: 'unavailable',
                unavailableReason: 'launch_gate',
            });
            const promoted = preflightStatusV1Schema.parse({
                ...result,
                requiredPlan: 'plus',
                plans: result.plans.map(plan => {
                    if (plan.planId === 'standard') {
                        return {
                            ...plan,
                            launchStatus: 'disabled',
                            selectionState: 'unavailable',
                            unavailableReason: 'launch_gate',
                        };
                    }
                    if (plan.planId === 'plus') {
                        return {
                            ...plan,
                            launchStatus: 'test_only',
                            selectionState: 'required',
                            unavailableReason: null,
                        };
                    }
                    return plan;
                }),
            });
            expect(promoted).toMatchObject({
                status: 'ready',
                capacityRequiredPlan: 'standard',
                requiredPlan: 'plus',
            });

            expect(preflightStatusV1Schema.safeParse({
                ...result,
                target: { ...result.target, isPrivate: true },
            }).success).toBe(false);
            expect(preflightStatusV1Schema.safeParse({
                ...result,
                requiredPlan: 'basic',
                plans: result.plans.map((plan, index) => ({
                    ...plan,
                    selectionState: index === 0 ? 'required' : 'available_upgrade',
                    unavailableReason: null,
                })),
            }).success).toBe(false);
            expect(preflightStatusV1Schema.safeParse({
                ...result,
                target: {
                    ...result.target,
                    profileImage: 'https://cdninstagram.com/raw.jpg',
                },
            }).success).toBe(false);
            expect(preflightStatusV1Schema.safeParse({
                ...result,
                plans: result.plans.map(plan => plan.planId === 'standard'
                    ? { ...plan, launchStatus: 'production' }
                    : plan),
            }).success).toBe(true);
            expect(preflightStatusV1Schema.safeParse({
                ...result,
                plans: result.plans.map(plan => plan.planId === 'plus'
                    ? { ...plan, unavailableReason: null }
                    : plan),
            }).success).toBe(false);
        }
    });

    it('rejects hidden raw evidence fields from progress snapshots', () => {
        const track = {
            state: 'running',
            stageCode: 'PROFILE_TRIAGE',
            done: 1,
            total: 10,
            progressBp: 1_000,
        };
        const pendingTrack = {
            state: 'pending',
            stageCode: 'WAITING',
            done: 0,
            total: 10,
            progressBp: 0,
        };
        const snapshot = {
            schemaVersion: 1,
            requestId,
            revision: 2,
            status: 'processing',
            progressBp: 2_000,
            backgroundProcessing: true,
            tracks: {
                relationshipAi: track,
                interactions: pendingTrack,
                finalization: pendingTrack,
            },
            activeProfile: { maskedUsername: 'a***e', imageUrl: null },
            etaRange: { lowSeconds: 30, highSeconds: 90 },
            lastEventSeq: 4,
            comments: ['raw comment'],
        };

        expect(progressSnapshotV1Schema.safeParse(snapshot).success).toBe(false);
        delete (snapshot as { comments?: string[] }).comments;
        expect(progressSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
        expect(progressSnapshotV1Schema.safeParse({
            ...snapshot,
            backgroundProcessing: false,
        }).success).toBe(false);
        expect(progressSnapshotV1Schema.safeParse({
            ...snapshot,
            tracks: {
                ...snapshot.tracks,
                interactions: { ...pendingTrack, done: 1 },
            },
        }).success).toBe(false);
    });

    it('allows two-line narratives only on high-risk rows', () => {
        const base = {
            schemaVersion: 1,
            requestId,
            summary: {
                targetInstagramId: 'target',
                targetProfileImage: null,
                planId: 'basic',
                followers: {
                    declared: 100,
                    collected: 100,
                    coverageRatio: 1,
                    meetsCoverageGate: true,
                    exactCountMatch: true,
                },
                following: {
                    declared: 100,
                    collected: 99,
                    coverageRatio: 0.99,
                    meetsCoverageGate: true,
                    exactCountMatch: false,
                },
                detectedMutuals: 50,
                publicMutuals: 40,
                privateMutuals: 10,
                screenedMutuals: 40,
                successfullyScreenedMutuals: 38,
                fetchUnavailableMutuals: 1,
                mediaUnavailableMutuals: 1,
                notScreenedMutuals: 0,
                exclusionApplied: true,
                scorePolicyVersion: 'risk-policy-v2.2',
            },
            privateAccounts: [],
            femaleNextCursor: null,
            privateNextCursor: null,
        };
        const row = {
            instagramId: 'candidate',
            fullName: null,
            profileImage: null,
            bio: null,
            displayScore: 7.2,
            riskBand: 'high_risk',
            featuredRank: 1,
            recentMutualRank: 2,
            analysisDepth: 'narrative',
            oneLineOverview: '사진과 여행 기록이 많은 공개 계정.',
            highRiskNarrative: [
                '공개 프로필과 피드는 굳이 눈에 띄는 스타일입니다.',
                '댓글 내용은 제법 친절하지만 수집 표본 밖 누락 가능성은 남습니다.',
            ],
        };

        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            femaleAccounts: [row],
        }).success).toBe(true);
        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            summary: {
                ...base.summary,
                successfullyScreenedMutuals: 39,
            },
            femaleAccounts: [row],
        }).success).toBe(false);
        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            femaleAccounts: [{ ...row, riskBand: 'normal' }],
        }).success).toBe(false);
        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            femaleAccounts: [{ ...row, highRiskNarrative: null }],
        }).success).toBe(false);
        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            femaleAccounts: [{
                ...row,
                oneLineOverview: '좋아요 17회가 확인된 계정.',
            }],
        }).success).toBe(false);
        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            femaleAccounts: [{
                ...row,
                oneLineOverview: '좋아요 두 번이 확인된 계정.',
            }],
        }).success).toBe(false);
        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            femaleAccounts: [{
                ...row,
                highRiskNarrative: [
                    '사진 중심 공개 계정이라 굳이 눈에 띕니다.',
                    '댓글 흔적은 있지만 둘은 바람을 피우고 있다.',
                ],
            }],
        }).success).toBe(false);
        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            femaleAccounts: [{ ...row, displayScore: 3.4 }],
        }).success).toBe(false);
        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            femaleAccounts: [row],
            femaleNextCursor: 'raw-comment-or-evidence',
        }).success).toBe(false);

        const validCursor = encodeResultCursor({
            version: 1,
            list: 'public',
            direction: 'desc',
            sortKeyType: 'number',
            sortKey: 7.2,
            candidateId: 'candidate',
        });
        expect(analysisResultPageV1Schema.safeParse({
            ...base,
            femaleAccounts: [row],
            femaleNextCursor: validCursor,
        }).success).toBe(true);
    });

    it('rejects final results below coverage or above the selected detailed scope', () => {
        const summary = {
            targetInstagramId: 'target',
            targetProfileImage: null,
            planId: 'basic',
            followers: {
                declared: 400,
                collected: 400,
                coverageRatio: 1,
                meetsCoverageGate: true,
                exactCountMatch: true,
            },
            following: {
                declared: 400,
                collected: 400,
                coverageRatio: 1,
                meetsCoverageGate: true,
                exactCountMatch: true,
            },
            detectedMutuals: 400,
            publicMutuals: 390,
            privateMutuals: 10,
            screenedMutuals: 350,
            successfullyScreenedMutuals: 350,
            fetchUnavailableMutuals: 0,
            mediaUnavailableMutuals: 0,
            notScreenedMutuals: 40,
            exclusionApplied: true,
            scorePolicyVersion: 'risk-policy-v2.2',
        };
        const page = {
            schemaVersion: 1,
            requestId,
            summary,
            femaleAccounts: [],
            privateAccounts: [],
            femaleNextCursor: null,
            privateNextCursor: null,
        };

        expect(analysisResultPageV1Schema.safeParse(page).success).toBe(false);
        expect(analysisResultPageV1Schema.safeParse({
            ...page,
            summary: {
                ...summary,
                screenedMutuals: 300,
                successfullyScreenedMutuals: 300,
                notScreenedMutuals: 90,
                following: {
                    declared: 400,
                    collected: 395,
                    coverageRatio: 395 / 400,
                    meetsCoverageGate: false,
                    exactCountMatch: false,
                },
            },
        }).success).toBe(false);
    });

    it('rejects duplicated or inconsistent plan cards', () => {
        const parsed = preflightStatusV1Schema.safeParse({
            schemaVersion: 1,
            preflightId: requestId,
            expiresAt,
            status: 'ready',
            exclusionDecision: 'pending',
            target: {
                username: 'target',
                fullName: null,
                bio: null,
                profileImage: null,
                followersCount: 650,
                followingCount: 500,
                isPrivate: false,
            },
            accessMode: 'test_entitlement',
            capacityRequiredPlan: 'standard',
            requiredPlan: 'standard',
            pricingVersion: 'deferred',
            plans: [
                {
                    planId: 'basic',
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 400, following: 400 },
                    detailedMutualLimit: 300,
                    selectionState: 'unavailable',
                    unavailableReason: 'below_required_plan',
                    pricingVersion: 'deferred',
                    price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
                {
                    planId: 'basic',
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 800, following: 800 },
                    detailedMutualLimit: 600,
                    selectionState: 'required',
                    unavailableReason: null,
                    pricingVersion: 'deferred',
                    price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
                {
                    planId: 'plus',
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 1_200, following: 1_200 },
                    detailedMutualLimit: 900,
                    selectionState: 'available_upgrade',
                    unavailableReason: null,
                    pricingVersion: 'deferred',
                    price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
            ],
        });

        expect(parsed.success).toBe(false);
    });
});
