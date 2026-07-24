import { z } from 'zod';
import { canonicalizeImageProxyUrl } from './image-proxy-token';
import type { AnalysisV2ResultImageLocator } from './image-proxy-token';
import {
    createResultImageR2Reader,
    loadResultImageR2Config,
} from './r2-result-image-store';

export const ANALYSIS_V2_RESULT_IMAGE_RPC =
    'load_analysis_v2_result_image_url';
export const RESULT_IMAGE_OBJECT_RPC =
    'load_analysis_v2_result_image_object';

const OBJECT_KEY_PATTERN = /^v1\/[0-9a-f]{32}\/(target|female|private)\/[0-9a-f]{32}\.webp$/;

const r2LocatorSchema = z.object({
    objectKey: z.string().regex(OBJECT_KEY_PATTERN),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteSize: z.number().int().min(1).max(128 * 1024),
    expiresAt: z.string().datetime({ offset: true }),
}).strict();

export type ResolvedResultImage =
    | { source: 'legacy_url'; url: string }
    | {
        source: 'r2';
        objectKey: string;
        sha256: string;
        byteSize: number;
        expiresAt: string;
    };

export interface ResultImageResolverClient {
    rpc(
        name: string,
        params: Record<string, unknown>
    ): PromiseLike<{
        data: unknown;
        error: { code?: string; message?: string } | null;
    }>;
}

type ResultImageResolverOptions = {
    client?: ResultImageResolverClient;
    env?: Readonly<Record<string, string | undefined>>;
    now?: () => number;
};

async function resolverClient(
    override?: ResultImageResolverClient
): Promise<ResultImageResolverClient> {
    if (override) return override;
    // Keep the service-role client out of the image route's module-load path.
    const { supabaseAdmin } = await import('@/lib/supabase/admin');
    return supabaseAdmin;
}

function enabledFlag(
    env: Readonly<Record<string, string | undefined>>
): boolean | null {
    const value = env.ANALYSIS_V2_RESULT_IMAGES_ENABLED?.trim()
        ?? 'false';
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

export async function resolveAnalysisV2ResultImageLocator(
    locator: AnalysisV2ResultImageLocator,
    userId: string,
    options: ResultImageResolverOptions = {}
): Promise<ResolvedResultImage | null> {
    const env = options.env ?? process.env;
    const enabled = enabledFlag(env);
    if (enabled === null) return null;
    const client = await resolverClient(options.client);
    const params = {
        p_request_id: locator.requestId,
        p_user_id: userId,
        p_kind: locator.kind,
        p_candidate_id: locator.candidateId,
    };

    try {
        const { data, error } = await client.rpc(
            enabled
                ? RESULT_IMAGE_OBJECT_RPC
                : ANALYSIS_V2_RESULT_IMAGE_RPC,
            params
        );
        if (error) return null;
        if (!enabled) {
            if (typeof data !== 'string') return null;
            return {
                source: 'legacy_url',
                url: canonicalizeImageProxyUrl(data),
            };
        }
        const parsed = r2LocatorSchema.safeParse(data);
        if (!parsed.success) return null;
        const expiresAtMs = Date.parse(parsed.data.expiresAt);
        if (
            !Number.isFinite(expiresAtMs)
            || expiresAtMs <= (options.now ?? Date.now)()
        ) {
            return null;
        }
        return {
            source: 'r2',
            ...parsed.data,
        };
    } catch {
        return null;
    }
}

export async function readAnalysisV2ResultImageObject(
    locator: Extract<ResolvedResultImage, { source: 'r2' }>,
    env: Readonly<Record<string, string | undefined>> = process.env
): Promise<Buffer> {
    if (Date.parse(locator.expiresAt) <= Date.now()) {
        throw new Error('R2_RESULT_IMAGE_EXPIRED');
    }
    const reader = createResultImageR2Reader(
        loadResultImageR2Config(env)
    );
    return reader.get({
        objectKey: locator.objectKey,
        expectedByteSize: locator.byteSize,
        expectedSha256: locator.sha256,
    });
}
