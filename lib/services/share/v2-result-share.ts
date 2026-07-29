import { z } from 'zod';
import {
    analysisResultSummaryV1Schema,
    femaleResultRowV1Schema,
    type AnalysisResultPageV1,
} from '@/lib/contracts/analysis-v2';
import {
    RESULT_PAGE_SIZE_MAX,
    ResultPaginationError,
    decodeResultCursor,
} from '@/lib/domain/analysis/result-pagination';
import {
    createSupabaseAnalysisV2ResultStore,
    type AnalysisV2ResultStore,
} from '@/lib/services/analysis/v2-result-store';
import type {
    AnalysisV2ResultImageLocator,
} from '@/lib/services/media/image-proxy-token';
import {
    createV2SharedAccountKey,
    maskSharedFullName,
    maskSharedHandle,
    openV2SharedCursor,
    sealV2SharedCursor,
    sealV2SharedImageLocator,
} from '@/lib/services/share/v2-share-privacy';
import { supabaseAdmin } from '@/lib/supabase/admin';

const SHARE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHARED_TARGET_IMAGE_PATTERN =
    /^\/api\/share\/[0-9a-f]{64}\/image\?kind=target$/;
const SHARED_ACCOUNT_IMAGE_PATTERN =
    /^\/api\/share\/[0-9a-f]{64}\/image\?locator=[A-Za-z0-9_-]{40,1900}$/;

type ShareImageSigner = (
    rawUrl: string | null,
    locator: AnalysisV2ResultImageLocator
) => string | null;

type ShareResultStore = Pick<AnalysisV2ResultStore, 'loadPage'>;

type V2ShareResultDependencies = {
    createStore?: (imageProxySigner: ShareImageSigner) => ShareResultStore;
};

function validateOwnerCursor(
    cursor: string | null | undefined,
    list: 'public' | 'private'
): void {
    if (!cursor) return;
    const decoded = decodeResultCursor(cursor);
    if (
        decoded.list !== list
        || decoded.direction !== 'asc'
        || decoded.sortKeyType !== 'number'
    ) {
        throw new ResultPaginationError('CURSOR_SCOPE_MISMATCH');
    }
}

function ownerCursorFromShared(
    cursor: string | null | undefined,
    list: 'public' | 'private',
    shareToken: string
): string | null | undefined {
    if (!cursor) return cursor;
    const ownerCursor = openV2SharedCursor(shareToken, cursor);
    if (!ownerCursor) {
        throw new ResultPaginationError('INVALID_CURSOR');
    }
    validateOwnerCursor(ownerCursor, list);
    return ownerCursor;
}

const sharedResultSummarySchema = z.object({
    targetInstagramId:
        analysisResultSummaryV1Schema.shape.targetInstagramId,
    targetFullName:
        analysisResultSummaryV1Schema.shape.targetFullName,
    targetProfileImage: z.string()
        .max(2_048)
        .regex(SHARED_TARGET_IMAGE_PATTERN)
        .nullable(),
    planId: analysisResultSummaryV1Schema.shape.planId,
    followers: analysisResultSummaryV1Schema.shape.followers,
    following: analysisResultSummaryV1Schema.shape.following,
    detectedMutuals:
        analysisResultSummaryV1Schema.shape.detectedMutuals,
    publicMutuals: analysisResultSummaryV1Schema.shape.publicMutuals,
    privateMutuals: analysisResultSummaryV1Schema.shape.privateMutuals,
    screenedMutuals:
        analysisResultSummaryV1Schema.shape.screenedMutuals,
    genderStats: analysisResultSummaryV1Schema.shape.genderStats,
    notScreenedMutuals:
        analysisResultSummaryV1Schema.shape.notScreenedMutuals,
    exclusionApplied:
        analysisResultSummaryV1Schema.shape.exclusionApplied,
    scorePolicyVersion:
        analysisResultSummaryV1Schema.shape.scorePolicyVersion,
}).strict();

const accountKeySchema = z.string()
    .regex(/^account_[A-Za-z0-9_-]{43}$/);
const maskedHandleSchema = z.string().min(1).max(30);
const maskedFullNameSchema = z.string().max(200).nullable();
const sharedAccountImageSchema = z.string()
    .max(2_048)
    .regex(SHARED_ACCOUNT_IMAGE_PATTERN)
    .nullable();
const sharedCursorSchema = z.string()
    .regex(/^[A-Za-z0-9_-]{40,4096}$/)
    .nullable();

const sharedFemaleResultRowSchema = z.object({
    accountKey: accountKeySchema,
    handleMasked: maskedHandleSchema,
    fullNameMasked: maskedFullNameSchema,
    profileImage: sharedAccountImageSchema,
    bio: femaleResultRowV1Schema.shape.bio,
    displayScore: femaleResultRowV1Schema.shape.displayScore,
    riskBand: femaleResultRowV1Schema.shape.riskBand,
    featuredRank: femaleResultRowV1Schema.shape.featuredRank,
    recentMutualRank: femaleResultRowV1Schema.shape.recentMutualRank,
    analysisDepth: femaleResultRowV1Schema.shape.analysisDepth,
    oneLineOverview: femaleResultRowV1Schema.shape.oneLineOverview,
    highRiskNarrative:
        femaleResultRowV1Schema.shape.highRiskNarrative,
}).strict();

const sharedPrivateResultRowSchema = z.object({
    accountKey: accountKeySchema,
    handleMasked: maskedHandleSchema,
    fullNameMasked: maskedFullNameSchema,
    profileImage: sharedAccountImageSchema,
}).strict();

export const v2SharedResultPageSchema = z.object({
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    summary: sharedResultSummarySchema,
    femaleAccounts: z.array(sharedFemaleResultRowSchema)
        .max(RESULT_PAGE_SIZE_MAX),
    privateAccounts: z.array(sharedPrivateResultRowSchema)
        .max(RESULT_PAGE_SIZE_MAX),
    femaleNextCursor: sharedCursorSchema,
    privateNextCursor: sharedCursorSchema,
    isShared: z.literal(true),
}).strict().superRefine((value, context) => {
    const accountKeys = new Set<string>();
    for (const [collection, rows] of [
        ['femaleAccounts', value.femaleAccounts],
        ['privateAccounts', value.privateAccounts],
    ] as const) {
        rows.forEach((row, index) => {
            if (accountKeys.has(row.accountKey)) {
                context.addIssue({
                    code: 'custom',
                    message: 'Shared account keys must be unique.',
                    path: [collection, index, 'accountKey'],
                });
            }
            accountKeys.add(row.accountKey);
        });
    }
});

export type V2SharedResultPage = z.infer<typeof v2SharedResultPageSchema>;

export function createV2ShareImagePath(
    shareToken: string,
    locator: AnalysisV2ResultImageLocator
): string {
    if (
        !SHARE_TOKEN_PATTERN.test(shareToken)
        || !UUID_PATTERN.test(locator.requestId)
        || !['target', 'female', 'private'].includes(locator.kind)
        || (
            locator.kind === 'target'
                ? locator.candidateId !== null
                : !locator.candidateId
                    || !CANDIDATE_ID_PATTERN.test(locator.candidateId)
        )
    ) {
        throw new Error('INVALID_V2_SHARE_IMAGE_INPUT');
    }
    const params = new URLSearchParams({ kind: locator.kind });
    if (locator.kind !== 'target' && locator.candidateId !== null) {
        params.delete('kind');
        params.set(
            'locator',
            sealV2SharedImageLocator(shareToken, {
                ...locator,
                kind: locator.kind,
                candidateId: locator.candidateId,
            })
        );
    }
    return `/api/share/${shareToken}/image?${params.toString()}`;
}

function sharedFemaleRow(
    row: AnalysisResultPageV1['femaleAccounts'][number],
    shareToken: string
) {
    const {
        instagramId,
        fullName,
        ...allowed
    } = row;
    return {
        accountKey: createV2SharedAccountKey(
            shareToken,
            'female',
            instagramId
        ),
        handleMasked: maskSharedHandle(instagramId),
        fullNameMasked: maskSharedFullName(fullName),
        ...allowed,
    };
}

function sharedPrivateRow(
    row: AnalysisResultPageV1['privateAccounts'][number],
    shareToken: string
) {
    const {
        instagramId,
        fullName,
        ...allowed
    } = row;
    return {
        accountKey: createV2SharedAccountKey(
            shareToken,
            'private',
            instagramId
        ),
        handleMasked: maskSharedHandle(instagramId),
        fullNameMasked: maskSharedFullName(fullName),
        ...allowed,
    };
}

export function createV2ShareResultService(
    dependencies: V2ShareResultDependencies = {}
) {
    return {
        async loadPage(input: {
            requestId: string;
            ownerUserId: string;
            shareToken: string;
            femaleCursor?: string | null;
            privateCursor?: string | null;
            pageSize?: number;
        }): Promise<V2SharedResultPage | null> {
            if (
                !UUID_PATTERN.test(input.requestId)
                || !UUID_PATTERN.test(input.ownerUserId)
                || !SHARE_TOKEN_PATTERN.test(input.shareToken)
                || (
                    input.pageSize !== undefined
                    && (
                        !Number.isSafeInteger(input.pageSize)
                        || input.pageSize < 1
                        || input.pageSize > RESULT_PAGE_SIZE_MAX
                    )
                )
            ) {
                throw new Error('INVALID_V2_SHARE_RESULT_INPUT');
            }
            const femaleCursor = ownerCursorFromShared(
                input.femaleCursor,
                'public',
                input.shareToken
            );
            const privateCursor = ownerCursorFromShared(
                input.privateCursor,
                'private',
                input.shareToken
            );
            const signer: ShareImageSigner = (_rawUrl, locator) => (
                createV2ShareImagePath(input.shareToken, locator)
            );
            const store = dependencies.createStore?.(signer)
                ?? createSupabaseAnalysisV2ResultStore(
                    supabaseAdmin,
                    { imageProxySigner: signer }
                );
            const page: AnalysisResultPageV1 | null = await store.loadPage({
                requestId: input.requestId,
                userId: input.ownerUserId,
                femaleCursor,
                privateCursor,
                pageSize: input.pageSize,
            });
            if (!page) return null;
            return v2SharedResultPageSchema.parse({
                schemaVersion: page.schemaVersion,
                requestId: page.requestId,
                summary: page.summary,
                femaleAccounts: page.femaleAccounts.map(row => (
                    sharedFemaleRow(row, input.shareToken)
                )),
                privateAccounts: page.privateAccounts.map(row => (
                    sharedPrivateRow(row, input.shareToken)
                )),
                femaleNextCursor: page.femaleNextCursor
                    ? sealV2SharedCursor(
                        input.shareToken,
                        page.femaleNextCursor
                    )
                    : null,
                privateNextCursor: page.privateNextCursor
                    ? sealV2SharedCursor(
                        input.shareToken,
                        page.privateNextCursor
                    )
                    : null,
                isShared: true,
            });
        },
    };
}

export const v2ShareResultService = createV2ShareResultService();
