import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    createResultImageR2Writer,
    loadResultImageR2Config,
} from './r2-result-image-store';
import {
    createResultImageRegistry,
    type ResultImageRegistry,
} from './result-image-registry';

export const RESULT_IMAGE_PURGE_LIMIT = 100;
export const RESULT_IMAGE_PURGE_CONCURRENCY = 8;
export const RESULT_IMAGE_PURGE_LEASE_SECONDS = 300;

export type ResultImagePurgeSummary = Readonly<{
    claimed: number;
    deleted: number;
    failed: number;
    hasMore: boolean;
}>;

type ResultImagePurgeWriter = {
    delete(objectKey: string): Promise<void>;
};

type ResultImagePurgeDependencies = {
    registry?: Pick<
        ResultImageRegistry,
        'claimPurge' | 'completePurge'
    >;
    writer?: ResultImagePurgeWriter;
    env?: Readonly<Record<string, string | undefined>>;
    claimToken?: () => string;
    limit?: number;
    concurrency?: number;
};

function enabled(
    env: Readonly<Record<string, string | undefined>>
): boolean {
    const value = env.ANALYSIS_V2_RESULT_IMAGES_ENABLED?.trim()
        ?? 'false';
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error('RESULT_IMAGE_PURGE_INVALID_CONFIGURATION');
}

function validateBoundedInteger(
    value: number,
    minimum: number,
    maximum: number
): number {
    if (
        !Number.isSafeInteger(value)
        || value < minimum
        || value > maximum
    ) {
        throw new Error('RESULT_IMAGE_PURGE_INVALID_CONFIGURATION');
    }
    return value;
}

export async function purgeConfiguredResultImages(
    dependencies: ResultImagePurgeDependencies = {}
): Promise<ResultImagePurgeSummary> {
    const env = dependencies.env ?? process.env;
    if (!enabled(env)) {
        return Object.freeze({
            claimed: 0,
            deleted: 0,
            failed: 0,
            hasMore: false,
        });
    }

    const limit = validateBoundedInteger(
        dependencies.limit ?? RESULT_IMAGE_PURGE_LIMIT,
        1,
        RESULT_IMAGE_PURGE_LIMIT
    );
    const concurrency = validateBoundedInteger(
        dependencies.concurrency ?? RESULT_IMAGE_PURGE_CONCURRENCY,
        1,
        RESULT_IMAGE_PURGE_CONCURRENCY
    );
    const claimToken = (dependencies.claimToken ?? randomUUID)();
    const registry = dependencies.registry
        ?? createResultImageRegistry(supabaseAdmin);
    const writer = dependencies.writer
        ?? createResultImageR2Writer(loadResultImageR2Config(env));
    const claims = await registry.claimPurge({
        claimToken,
        limit,
        leaseSeconds: RESULT_IMAGE_PURGE_LEASE_SECONDS,
    });
    let cursor = 0;
    let deleted = 0;
    let failed = 0;

    const worker = async () => {
        while (cursor < claims.length) {
            const claim = claims[cursor++];
            try {
                await writer.delete(claim.objectKey);
                const completed = await registry.completePurge({
                    objectKey: claim.objectKey,
                    claimToken,
                    deleted: true,
                });
                if (!completed) {
                    failed += 1;
                    continue;
                }
                deleted += 1;
            } catch {
                failed += 1;
            }
        }
    };
    await Promise.all(Array.from(
        { length: Math.min(concurrency, claims.length) },
        () => worker()
    ));

    return Object.freeze({
        claimed: claims.length,
        deleted,
        failed,
        hasMore: claims.length === limit,
    });
}
