import { z } from 'zod';
import {
    analysisResultPageV1Schema,
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
import { supabaseAdmin } from '@/lib/supabase/admin';

const SHARE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type ShareImageSigner = (
    rawUrl: string | null,
    locator: AnalysisV2ResultImageLocator
) => string | null;

type ShareResultStore = Pick<AnalysisV2ResultStore, 'loadPage'>;

type V2ShareResultDependencies = {
    createStore?: (imageProxySigner: ShareImageSigner) => ShareResultStore;
};

function validateCursor(
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

export const v2SharedResultPageSchema = analysisResultPageV1Schema.safeExtend({
    isShared: z.literal(true),
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
    if (locator.candidateId !== null) {
        params.set('candidateId', locator.candidateId);
    }
    return `/api/share/${shareToken}/image?${params.toString()}`;
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
            validateCursor(input.femaleCursor, 'public');
            validateCursor(input.privateCursor, 'private');
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
                femaleCursor: input.femaleCursor,
                privateCursor: input.privateCursor,
                pageSize: input.pageSize,
            });
            if (!page) return null;
            return v2SharedResultPageSchema.parse({
                ...page,
                isShared: true,
            });
        },
    };
}

export const v2ShareResultService = createV2ShareResultService();
