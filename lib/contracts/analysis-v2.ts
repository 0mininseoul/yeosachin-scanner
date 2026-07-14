import { z } from 'zod';
import {
    PLAN_ACCESS_MODES,
    PLAN_IDS,
    PLAN_LAUNCH_STATUSES,
    assessRelationshipCoverage,
    buildPlanSelectionCards,
    calculateDetailedScreeningScope,
    determinePlanEligibility,
    getAnalysisPlan,
    type PlanEligibilityCatalog,
} from '@/lib/domain/analysis/plan-catalog';
import { CURRENT_ANALYSIS_PIPELINE_VERSION } from '@/lib/domain/analysis/pipeline-version';
import { calculateTrackProgressBp } from '@/lib/domain/analysis/progress-policy';
import {
    RISK_BANDS,
    RISK_POLICY_VERSION,
    isRiskBandCompatibleWithDisplayScore,
} from '@/lib/domain/analysis/risk-policy';
import {
    RESULT_PAGE_SIZE_MAX,
    decodeResultCursor,
} from '@/lib/domain/analysis/result-pagination';
import {
    containsDefinitiveRelationshipAccusation,
    containsExposedInteractionMetric,
    parseSafePublicRiskNarrative,
} from '@/lib/services/analysis/narrative-privacy';

export const ANALYSIS_V2_SCHEMA_VERSION = 1 as const;
export const ANALYSIS_V2_PIPELINE_VERSION = CURRENT_ANALYSIS_PIPELINE_VERSION;

const usernameSchema = z.string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9._]+$/)
    .transform(value => value.toLowerCase());
const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const boundedImageUrlSchema = z.string()
    .trim()
    .min(1)
    .max(2_048)
    .refine(value => value.startsWith('/api/image-proxy?'), {
        message: 'Public image URLs must use the signed image proxy.',
    })
    .nullable();
const stageCodeSchema = z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/);

const FORBIDDEN_PUBLIC_COPY_PATTERNS = [
    /https?:\/\//iu,
    /www\./iu,
    /@/u,
] as const;

function publicCopySchema(maxLength: number) {
    return z.string()
        .trim()
        .min(1)
        .max(maxLength)
        .regex(/[가-힣]/u, 'Public analysis copy must contain Korean text.')
        .refine(value => !/[\r\n]/u.test(value), 'Public analysis copy must be one line.')
        .refine(
            value => FORBIDDEN_PUBLIC_COPY_PATTERNS.every(pattern => !pattern.test(value)),
            'Public analysis copy contains an identifier or URL.'
        )
        .refine(
            value => !containsExposedInteractionMetric(value),
            'Public analysis copy contains an exposed interaction metric.'
        )
        .refine(
            value => !containsDefinitiveRelationshipAccusation(value),
            'Public analysis copy contains a factual relationship accusation.'
        );
}

function resultCursorSchema(list: 'public' | 'private') {
    return z.string().min(1).max(1_024).superRefine((value, context) => {
        try {
            const payload = decodeResultCursor(value);
            if (payload.list !== list) {
                context.addIssue({
                    code: 'custom',
                    message: 'Result cursor list does not match the response collection.',
                });
            }
        } catch {
            context.addIssue({
                code: 'custom',
                message: 'Result cursor is malformed.',
            });
        }
    });
}

export const planIdSchema = z.enum(PLAN_IDS);
export const planLaunchStatusSchema = z.enum(PLAN_LAUNCH_STATUSES);
export const planAccessModeSchema = z.enum(PLAN_ACCESS_MODES);
export const riskBandSchema = z.enum(RISK_BANDS);
export const preflightExclusionDecisionV1Schema = z.enum(['pending', 'exclude', 'skip']);

export const analysisV2ErrorCodeSchema = z.enum([
    'TARGET_NOT_FOUND',
    'TARGET_PRIVATE',
    'TARGET_UNSUPPORTED',
    'OVER_PLUS_CAPACITY',
    'EXCLUSION_REQUIRED',
    'INVALID_EXCLUSION',
    'PLAN_UPGRADE_REQUIRED',
    'RELATIONSHIP_INCOMPLETE',
    'PROFILE_EVIDENCE_INCOMPLETE',
    'QUEUE_UNAVAILABLE',
    'AI_RATE_LIMITED',
    'AI_AMBIGUOUS_RESULT',
    'ANALYSIS_FAILED',
]);

export type AnalysisV2ErrorCode = z.infer<typeof analysisV2ErrorCodeSchema>;

const relationshipCapacitySchema = z.object({
    followers: z.number().int().nonnegative(),
    following: z.number().int().nonnegative(),
}).strict();

const priceSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('deferred'),
        currency: z.literal('KRW'),
        amountKrw: z.null(),
    }).strict(),
    z.object({
        status: z.literal('quoted'),
        currency: z.literal('KRW'),
        amountKrw: z.number().int().positive(),
    }).strict(),
]);

export const planQuoteV1Schema = z.object({
    planId: planIdSchema,
    launchStatus: planLaunchStatusSchema,
    relationshipCapacity: relationshipCapacitySchema,
    detailedMutualLimit: z.number().int().positive(),
    selectionState: z.enum(['required', 'available_upgrade', 'unavailable']),
    unavailableReason: z.enum(['below_required_plan', 'launch_gate']).nullable(),
    pricingVersion: z.string().min(1).max(64),
    price: priceSchema,
}).strict();

const planQuotesV1Schema = z.array(planQuoteV1Schema)
    .length(PLAN_IDS.length)
    .superRefine((plans, context) => {
        plans.forEach((plan, index) => {
            if (plan.planId !== PLAN_IDS[index]) {
                context.addIssue({
                    code: 'custom',
                    message: 'Plans must contain every catalog entry in canonical order.',
                    path: [index, 'planId'],
                });
            }
        });
    });

export type PlanQuoteV1 = z.infer<typeof planQuoteV1Schema>;

export const preflightRequestV1Schema = z.object({
    targetInstagramId: usernameSchema,
}).strict();

export const preflightAcceptedV1Schema = z.object({
    schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
    preflightId: uuidSchema,
    expiresAt: timestampSchema,
    status: z.literal('pending'),
    exclusionDecision: z.literal('pending'),
}).strict();

const preflightPendingV1Schema = preflightAcceptedV1Schema.extend({
    exclusionDecision: preflightExclusionDecisionV1Schema,
});
const preflightReadyV1Schema = z.object({
    schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
    preflightId: uuidSchema,
    expiresAt: timestampSchema,
    status: z.literal('ready'),
    exclusionDecision: preflightExclusionDecisionV1Schema,
    target: z.object({
        username: usernameSchema,
        fullName: z.string().max(200).nullable(),
        bio: z.string().max(2_200).nullable(),
        profileImage: boundedImageUrlSchema,
        followersCount: z.number().int().nonnegative(),
        followingCount: z.number().int().nonnegative(),
        isPrivate: z.boolean(),
    }).strict(),
    accessMode: planAccessModeSchema,
    capacityRequiredPlan: planIdSchema,
    requiredPlan: planIdSchema,
    plans: planQuotesV1Schema,
    pricingVersion: z.string().min(1).max(64),
}).strict().superRefine((value, context) => {
    if (value.target.isPrivate) {
        context.addIssue({
            code: 'custom',
            message: 'A private target cannot enter the ready state.',
            path: ['target', 'isPrivate'],
        });
    }

    const counts = {
        followers: value.target.followersCount,
        following: value.target.followingCount,
    };
    if (value.plans.some((plan, index) => plan.planId !== PLAN_IDS[index])) {
        return;
    }
    const snapshotCatalog = Object.fromEntries(value.plans.map(plan => [plan.planId, {
        launchStatus: plan.launchStatus,
        relationshipCapacity: plan.relationshipCapacity,
        detailedMutualLimit: plan.detailedMutualLimit,
    }])) as PlanEligibilityCatalog;
    const eligibility = determinePlanEligibility(counts, {
        accessMode: value.accessMode,
        catalog: snapshotCatalog,
    });
    if (eligibility.status === 'blocked') {
        context.addIssue({
            code: 'custom',
            message: eligibility.reason === 'over_plus_capacity'
                ? 'An over-capacity target cannot enter the ready state.'
                : 'A target without a launch-enabled plan cannot enter the ready state.',
            path: ['target'],
        });
    } else {
        if (eligibility.capacityRequiredPlanId !== value.capacityRequiredPlan) {
            context.addIssue({
                code: 'custom',
                message: 'Capacity-required plan does not match target relationship counts.',
                path: ['capacityRequiredPlan'],
            });
        }
        if (eligibility.requiredPlanId !== value.requiredPlan) {
            context.addIssue({
                code: 'custom',
                message: 'Required plan does not match capacity and launch availability.',
                path: ['requiredPlan'],
            });
        }
    }

    const expectedCards = buildPlanSelectionCards(counts, {
        accessMode: value.accessMode,
        catalog: snapshotCatalog,
    });
    value.plans.forEach((plan, index) => {
        const expectedCard = expectedCards[index];
        if (plan.selectionState !== expectedCard.selectionState) {
            context.addIssue({
                code: 'custom',
                message: 'Plan selection state does not match capacity and launch availability.',
                path: ['plans', index, 'selectionState'],
            });
        }
        if (plan.unavailableReason !== expectedCard.unavailableReason) {
            context.addIssue({
                code: 'custom',
                message: 'Plan unavailability reason does not match the selection state.',
                path: ['plans', index, 'unavailableReason'],
            });
        }
        if (
            plan.pricingVersion !== value.pricingVersion
        ) {
            context.addIssue({
                code: 'custom',
                message: 'Plan quote pricing version must match the preflight and server catalog.',
                path: ['plans', index, 'pricingVersion'],
            });
        }
    });
});
const preflightBlockedV1Schema = z.object({
    schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
    preflightId: uuidSchema,
    expiresAt: timestampSchema,
    status: z.literal('blocked'),
    exclusionDecision: preflightExclusionDecisionV1Schema,
    code: analysisV2ErrorCodeSchema,
}).strict();
const preflightConsumedV1Schema = z.object({
    schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
    preflightId: uuidSchema,
    status: z.literal('consumed'),
    exclusionDecision: z.enum(['exclude', 'skip']),
    requestId: uuidSchema,
}).strict();

export const preflightStatusV1Schema = z.discriminatedUnion('status', [
    preflightPendingV1Schema,
    preflightReadyV1Schema,
    preflightBlockedV1Schema,
    preflightConsumedV1Schema,
]);

export const preflightExclusionRequestV1Schema = z.discriminatedUnion('decision', [
    z.object({
        decision: z.literal('exclude'),
        excludedInstagramId: usernameSchema,
    }).strict(),
    z.object({
        decision: z.literal('skip'),
    }).strict(),
]);

export type PreflightRequestV1 = z.infer<typeof preflightRequestV1Schema>;
export type PreflightAcceptedV1 = z.infer<typeof preflightAcceptedV1Schema>;
export type PreflightStatusV1 = z.infer<typeof preflightStatusV1Schema>;
export type PreflightExclusionDecisionV1 = z.infer<typeof preflightExclusionDecisionV1Schema>;
export type PreflightExclusionRequestV1 = z.infer<typeof preflightExclusionRequestV1Schema>;

const analysisRequestStatusSchema = z.enum([
    'queued',
    'processing',
    'completed',
    'failed',
    'upgrade_required',
]);

const freshAdmissionErrorCodeV1Schema = z.enum([
    'ANALYSIS_V2_PREFLIGHT_NOT_FOUND',
    'ANALYSIS_V2_PREFLIGHT_NOT_READY',
    'ANALYSIS_V2_PREFLIGHT_EXPIRED',
    'ANALYSIS_V2_PLAN_NOT_ALLOWED',
    'ANALYSIS_V2_TARGET_NOT_FOUND',
    'ANALYSIS_V2_TARGET_PRIVATE',
    'ANALYSIS_V2_TARGET_MISMATCH',
    'ANALYSIS_V2_OVER_PLUS_CAPACITY',
    'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE',
]);

const freshPlanQuoteV1Schema = planQuoteV1Schema.extend({
    unavailableReason: z.enum([
        'below_required_plan',
        'launch_gate',
        'over_plus_capacity',
    ]).nullable(),
}).strict();

const freshPlanQuotesV1Schema = z.array(freshPlanQuoteV1Schema)
    .length(PLAN_IDS.length)
    .superRefine((plans, context) => {
        plans.forEach((plan, index) => {
            if (plan.planId !== PLAN_IDS[index]) {
                context.addIssue({
                    code: 'custom',
                    message: 'Fresh plans must use canonical catalog order.',
                    path: [index, 'planId'],
                });
            }
        });
    });

export const freshPlanSnapshotV1Schema = z.object({
    followersCount: z.number().int().nonnegative().max(10_000_000),
    followingCount: z.number().int().nonnegative().max(10_000_000),
    capacityRequiredPlanId: planIdSchema.nullable(),
    requiredPlanId: planIdSchema.nullable(),
    selectedPlanId: planIdSchema,
    plans: freshPlanQuotesV1Schema,
    pricingVersion: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/),
    refreshedAt: timestampSchema,
}).strict().superRefine((value, context) => {
    const capacityPlanPresent = value.capacityRequiredPlanId !== null;
    const requiredPlanPresent = value.requiredPlanId !== null;
    if (capacityPlanPresent !== requiredPlanPresent) {
        context.addIssue({
            code: 'custom',
            message: 'Fresh capacity and required plans must both be present or absent.',
            path: ['requiredPlanId'],
        });
    }

    value.plans.forEach((plan, index) => {
        if (plan.pricingVersion !== value.pricingVersion) {
            context.addIssue({
                code: 'custom',
                message: 'Fresh plan pricing version must match its snapshot.',
                path: ['plans', index, 'pricingVersion'],
            });
        }
    });

    if (!capacityPlanPresent || !requiredPlanPresent) {
        value.plans.forEach((plan, index) => {
            if (plan.selectionState !== 'unavailable') {
                context.addIssue({
                    code: 'custom',
                    message: 'A blocked fresh snapshot cannot expose a selectable plan.',
                    path: ['plans', index, 'selectionState'],
                });
            }
        });
        return;
    }

    const capacityIndex = PLAN_IDS.indexOf(value.capacityRequiredPlanId!);
    const requiredIndex = PLAN_IDS.indexOf(value.requiredPlanId!);
    if (requiredIndex < capacityIndex) {
        context.addIssue({
            code: 'custom',
            message: 'Fresh required plan cannot be below its capacity plan.',
            path: ['requiredPlanId'],
        });
    }
    value.plans.forEach((plan, index) => {
        if (index < capacityIndex && (
            plan.selectionState !== 'unavailable'
            || plan.unavailableReason !== 'below_required_plan'
        )) {
            context.addIssue({
                code: 'custom',
                message: 'A plan below fresh capacity must be unavailable.',
                path: ['plans', index],
            });
        }
        if (index === requiredIndex && (
            plan.selectionState !== 'required'
            || plan.unavailableReason !== null
        )) {
            context.addIssue({
                code: 'custom',
                message: 'Fresh required plan card does not match requiredPlanId.',
                path: ['plans', index],
            });
        }
    });
});

export const freshAdmissionErrorResponseV1Schema = z.object({
    error: z.string().trim().min(1).max(200),
    code: freshAdmissionErrorCodeV1Schema,
    latestPlan: freshPlanSnapshotV1Schema.optional(),
}).strict();

export type FreshPlanSnapshotV1 = z.infer<typeof freshPlanSnapshotV1Schema>;

export const testEntitlementResponseV1Schema = z.discriminatedUnion('status', [
    z.object({
        schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
        preflightId: uuidSchema,
        status: z.literal('admission_pending'),
        backgroundProcessing: z.literal(true),
        retryAfterMs: z.number().int().min(250).max(30_000),
    }).strict(),
    z.object({
        schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
        requestId: uuidSchema,
        status: analysisRequestStatusSchema,
        backgroundProcessing: z.boolean(),
    }).strict(),
]);

export type TestEntitlementResponseV1 = z.infer<typeof testEntitlementResponseV1Schema>;

const progressTrackSchema = z.object({
    state: z.enum(['pending', 'running', 'completed', 'failed']),
    stageCode: stageCodeSchema,
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    progressBp: z.number().int().min(0).max(10_000),
}).strict().superRefine((value, context) => {
    if (value.done > value.total) {
        context.addIssue({ code: 'custom', message: 'done cannot exceed total', path: ['done'] });
        return;
    }
    if (value.progressBp !== calculateTrackProgressBp(value)) {
        context.addIssue({
            code: 'custom',
            message: 'Track progress does not match done and total.',
            path: ['progressBp'],
        });
    }
    if (value.state === 'pending' && value.done !== 0) {
        context.addIssue({
            code: 'custom',
            message: 'A pending track cannot report completed work.',
            path: ['done'],
        });
    }
    if (value.state === 'completed' && value.done !== value.total) {
        context.addIssue({
            code: 'custom',
            message: 'A completed track must finish every work unit.',
            path: ['done'],
        });
    }
});

export const progressSnapshotV1Schema = z.object({
    schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
    requestId: uuidSchema,
    revision: z.number().int().nonnegative(),
    status: z.enum(['queued', 'processing', 'completed', 'failed', 'upgrade_required']),
    progressBp: z.number().int().min(0).max(10_000),
    backgroundProcessing: z.boolean(),
    tracks: z.object({
        relationshipAi: progressTrackSchema,
        interactions: progressTrackSchema,
        finalization: progressTrackSchema,
    }).strict(),
    activeProfile: z.object({
        maskedUsername: z.string()
            .min(1)
            .max(30)
            .regex(/^[A-Za-z0-9._*]+$/)
            .regex(/\*/, 'Active profile username must be masked.'),
        imageUrl: boundedImageUrlSchema,
    }).strict().nullable(),
    etaRange: z.object({
        lowSeconds: z.number().int().nonnegative().max(3_600),
        highSeconds: z.number().int().nonnegative().max(3_600),
    }).strict().refine(value => value.lowSeconds <= value.highSeconds, {
        message: 'lowSeconds cannot exceed highSeconds',
    }).nullable(),
    lastEventSeq: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
    if (value.status === 'completed' && value.progressBp !== 10_000) {
        context.addIssue({
            code: 'custom',
            message: 'Completed progress must be 100 percent.',
            path: ['progressBp'],
        });
    }
    if (value.status !== 'completed' && value.progressBp === 10_000) {
        context.addIssue({
            code: 'custom',
            message: 'Only completed progress may reach 100 percent.',
            path: ['progressBp'],
        });
    }
    if (
        value.status === 'completed'
        && Object.values(value.tracks).some(track => track.state !== 'completed')
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Every track must be completed before the request completes.',
            path: ['tracks'],
        });
    }
    if (
        (value.status === 'queued' || value.status === 'processing')
        && !value.backgroundProcessing
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Active V2 work must be server-owned background processing.',
            path: ['backgroundProcessing'],
        });
    }
});

export const progressEventV1Schema = z.object({
    schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
    requestId: uuidSchema,
    seq: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    occurredAt: timestampSchema,
    state: z.enum(['provisional', 'confirmed', 'corrected']),
    eventCode: z.enum([
        'TARGET_PROFILE_READY',
        'RELATIONSHIP_PROGRESS',
        'PROFILE_SCREENED',
        'SHORTLIST_READY',
        'POTENTIAL_HIGH_RISK_FOUND',
        'FINDING_CORRECTED',
        'FINDING_CONFIRMED',
        'ANALYSIS_COMPLETED',
    ]),
    copyCode: stageCodeSchema,
    aggregateCount: z.number().int().nonnegative().max(10_000).nullable(),
}).strict();

export type ProgressSnapshotV1 = z.infer<typeof progressSnapshotV1Schema>;
export type ProgressEventV1 = z.infer<typeof progressEventV1Schema>;

export const progressReadV1Schema = z.object({
    schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
    snapshot: progressSnapshotV1Schema,
    events: z.array(progressEventV1Schema).max(200),
}).strict().superRefine((value, context) => {
    if (value.events.some(event => event.requestId !== value.snapshot.requestId)) {
        context.addIssue({
            code: 'custom',
            message: 'Progress events must belong to the snapshot request.',
            path: ['events'],
        });
    }
    for (let index = 1; index < value.events.length; index += 1) {
        if (value.events[index]!.seq !== value.events[index - 1]!.seq + 1) {
            context.addIssue({
                code: 'custom',
                message: 'Progress event pages must be contiguous.',
                path: ['events', index, 'seq'],
            });
        }
    }
    if (value.events.at(-1)?.seq !== undefined
        && value.events.at(-1)!.seq > value.snapshot.lastEventSeq) {
        context.addIssue({
            code: 'custom',
            message: 'Progress events cannot be newer than the snapshot.',
            path: ['events'],
        });
    }
});

export type ProgressReadV1 = z.infer<typeof progressReadV1Schema>;

const relationshipCoverageSchema = z.object({
    declared: z.number().int().nonnegative(),
    collected: z.number().int().nonnegative(),
    coverageRatio: z.number().min(0).max(1),
    meetsCoverageGate: z.boolean(),
    exactCountMatch: z.boolean(),
}).strict().superRefine((value, context) => {
    const expected = assessRelationshipCoverage(value.declared, value.collected);
    for (const [field, actual, expectedValue] of [
        ['coverageRatio', value.coverageRatio, expected.coverageRatio],
        ['meetsCoverageGate', value.meetsCoverageGate, expected.meetsCoverageGate],
        ['exactCountMatch', value.exactCountMatch, expected.exactCountMatch],
    ] as const) {
        if (actual !== expectedValue) {
            context.addIssue({
                code: 'custom',
                message: `${field} does not match declared and collected counts.`,
                path: [field],
            });
        }
    }
});

export const analysisResultSummaryV1Schema = z.object({
    targetInstagramId: usernameSchema,
    targetProfileImage: boundedImageUrlSchema,
    planId: planIdSchema,
    followers: relationshipCoverageSchema,
    following: relationshipCoverageSchema,
    detectedMutuals: z.number().int().nonnegative(),
    publicMutuals: z.number().int().nonnegative(),
    privateMutuals: z.number().int().nonnegative(),
    screenedMutuals: z.number().int().nonnegative(),
    successfullyScreenedMutuals: z.number().int().nonnegative(),
    fetchUnavailableMutuals: z.number().int().nonnegative(),
    mediaUnavailableMutuals: z.number().int().nonnegative(),
    notScreenedMutuals: z.number().int().nonnegative(),
    exclusionApplied: z.boolean(),
    scorePolicyVersion: z.literal(RISK_POLICY_VERSION),
}).strict().superRefine((value, context) => {
    for (const side of ['followers', 'following'] as const) {
        if (!value[side].meetsCoverageGate) {
            context.addIssue({
                code: 'custom',
                message: 'A final result requires both relationship coverage gates.',
                path: [side, 'meetsCoverageGate'],
            });
        }
    }

    const plan = getAnalysisPlan(value.planId);
    if (
        value.followers.declared > plan.relationshipCapacity.followers
        || value.followers.collected > plan.relationshipCapacity.followers
        || value.following.declared > plan.relationshipCapacity.following
        || value.following.collected > plan.relationshipCapacity.following
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Result relationship counts exceed the selected plan.',
            path: ['planId'],
        });
    }
    const expectedScreening = calculateDetailedScreeningScope(
        value.planId,
        value.publicMutuals
    );
    if (
        value.screenedMutuals !== expectedScreening.screened
        || value.notScreenedMutuals !== expectedScreening.notScreened
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Screening scope does not match the selected plan policy.',
            path: ['screenedMutuals'],
        });
    }
    if (value.publicMutuals + value.privateMutuals !== value.detectedMutuals) {
        context.addIssue({
            code: 'custom',
            message: 'Public and private mutual counts must equal detected mutuals.',
            path: ['detectedMutuals'],
        });
    }
    if (
        value.detectedMutuals > value.followers.collected
        || value.detectedMutuals > value.following.collected
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Detected mutuals cannot exceed either collected relationship list.',
            path: ['detectedMutuals'],
        });
    }
    if (value.screenedMutuals + value.notScreenedMutuals !== value.publicMutuals) {
        context.addIssue({
            code: 'custom',
            message: 'Screening scope must equal the public mutual count.',
            path: ['screenedMutuals'],
        });
    }
    if (
        value.successfullyScreenedMutuals
            + value.fetchUnavailableMutuals
            + value.mediaUnavailableMutuals
        !== value.screenedMutuals
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Successful and unavailable screening counts must equal the selected scope.',
            path: ['successfullyScreenedMutuals'],
        });
    }
});

export const femaleResultRowV1Schema = z.object({
    instagramId: usernameSchema,
    fullName: z.string().max(200).nullable(),
    profileImage: boundedImageUrlSchema,
    bio: z.string().max(2_200).nullable(),
    displayScore: z.number()
        .min(1)
        .max(10)
        .refine(value => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9, {
            message: 'Display score must have at most one decimal place.',
        }),
    riskBand: riskBandSchema,
    featuredRank: z.number().int().min(1).max(15).nullable(),
    recentMutualRank: z.number().int().min(1).max(10).nullable(),
    analysisDepth: z.enum(['features', 'narrative']),
    oneLineOverview: publicCopySchema(180),
    highRiskNarrative: z.tuple([
        publicCopySchema(180),
        publicCopySchema(180),
    ]).refine(value => parseSafePublicRiskNarrative(value) !== null, {
        message: 'High-risk narrative does not satisfy the public narrative contract.',
    }).nullable(),
}).strict().superRefine((value, context) => {
    const isFeaturedHighRisk = value.riskBand === 'high_risk'
        && value.featuredRank !== null
        && value.featuredRank <= 3;

    if (value.riskBand === 'normal' && value.featuredRank !== null) {
        context.addIssue({
            code: 'custom',
            message: 'Normal rows cannot have a featured rank.',
            path: ['featuredRank'],
        });
    }
    if (!isRiskBandCompatibleWithDisplayScore(value.displayScore, value.riskBand)) {
        context.addIssue({
            code: 'custom',
            message: 'Display score and risk band are inconsistent.',
            path: ['riskBand'],
        });
    }
    if (value.riskBand === 'high_risk' && value.featuredRank !== null && value.featuredRank > 3) {
        context.addIssue({
            code: 'custom',
            message: 'High-risk featured rank cannot exceed three.',
            path: ['featuredRank'],
        });
    }
    if (isFeaturedHighRisk && (!value.highRiskNarrative || value.analysisDepth !== 'narrative')) {
        context.addIssue({
            code: 'custom',
            message: 'Featured high-risk rows require a two-line narrative.',
            path: ['highRiskNarrative'],
        });
    }
    if (!isFeaturedHighRisk && value.highRiskNarrative) {
        context.addIssue({
            code: 'custom',
            message: 'Only featured high-risk rows may expose a narrative.',
            path: ['highRiskNarrative'],
        });
    }
    if (!isFeaturedHighRisk && value.analysisDepth === 'narrative') {
        context.addIssue({
            code: 'custom',
            message: 'Narrative depth is reserved for featured high-risk rows.',
            path: ['analysisDepth'],
        });
    }
});

export const privateResultRowV1Schema = z.object({
    instagramId: usernameSchema,
    fullName: z.string().max(200).nullable(),
    profileImage: boundedImageUrlSchema,
}).strict();

export const analysisResultPageV1Schema = z.object({
    schemaVersion: z.literal(ANALYSIS_V2_SCHEMA_VERSION),
    requestId: uuidSchema,
    summary: analysisResultSummaryV1Schema,
    femaleAccounts: z.array(femaleResultRowV1Schema).max(RESULT_PAGE_SIZE_MAX),
    privateAccounts: z.array(privateResultRowV1Schema).max(RESULT_PAGE_SIZE_MAX),
    femaleNextCursor: resultCursorSchema('public').nullable(),
    privateNextCursor: resultCursorSchema('private').nullable(),
}).strict().superRefine((value, context) => {
    const usernames = new Set<string>();
    for (const [collection, rows] of [
        ['femaleAccounts', value.femaleAccounts],
        ['privateAccounts', value.privateAccounts],
    ] as const) {
        rows.forEach((row, index) => {
            if (usernames.has(row.instagramId)) {
                context.addIssue({
                    code: 'custom',
                    message: 'An account cannot appear twice or in both result collections.',
                    path: [collection, index, 'instagramId'],
                });
            }
            usernames.add(row.instagramId);
        });
    }
});

export type AnalysisResultSummaryV1 = z.infer<typeof analysisResultSummaryV1Schema>;
export type FemaleResultRowV1 = z.infer<typeof femaleResultRowV1Schema>;
export type PrivateResultRowV1 = z.infer<typeof privateResultRowV1Schema>;
export type AnalysisResultPageV1 = z.infer<typeof analysisResultPageV1Schema>;
