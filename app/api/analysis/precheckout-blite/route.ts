import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import {
    preflightStore,
    type PreflightSupabaseClient,
    type StoredPreflight,
} from '@/lib/services/analysis/preflight';
import { readAnonymousAnalysisV2Preflight } from '@/lib/services/analysis/anonymous-preflight';
import { getInstagramProfile } from '@/lib/services/instagram/scraper';
import { inferPrecheckoutBlite } from '@/lib/services/precheckout/blite-inference';
import {
    precheckoutBliteV1Schema,
    type PrecheckoutBliteV1,
} from '@/lib/services/precheckout/blite-contract';

const requestBodySchema = z.object({
    preflightId: z.string().uuid(),
}).strict();

/** Server-only gate. Never exposed to the browser. */
const PRECHECKOUT_BLITE_ENABLED_FLAG = 'PRECHECKOUT_BLITE_ENABLED';

const PRECHECKOUT_BLITE_INFERENCE_TIMEOUT_MS = 8_000;
const PRECHECKOUT_BLITE_CACHE_TTL_MS = 5 * 60_000;
const PRECHECKOUT_BLITE_CACHE_MAX_ENTRIES = 200;

interface PrecheckoutBliteCacheEntry {
    dto: PrecheckoutBliteV1;
    expiresAt: number;
}

// In-process, short-TTL, size-bounded cache keyed by preflight id. Stored on `globalThis` so a
// warm serverless instance (or Next dev hot reload) reuses it instead of resetting per import.
const cacheScope = globalThis as typeof globalThis & {
    __PRECHECKOUT_BLITE_DTO_CACHE_V1__?: Map<string, PrecheckoutBliteCacheEntry>;
};
const dtoCache = cacheScope.__PRECHECKOUT_BLITE_DTO_CACHE_V1__ ?? new Map();
cacheScope.__PRECHECKOUT_BLITE_DTO_CACHE_V1__ = dtoCache;

function readCachedDto(preflightId: string): PrecheckoutBliteV1 | null {
    const entry = dtoCache.get(preflightId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        dtoCache.delete(preflightId);
        return null;
    }
    return entry.dto;
}

function writeCachedDto(preflightId: string, dto: PrecheckoutBliteV1): void {
    if (!dtoCache.has(preflightId) && dtoCache.size >= PRECHECKOUT_BLITE_CACHE_MAX_ENTRIES) {
        // Map preserves insertion order; drop the oldest entry to keep the cache bounded.
        const oldestKey = dtoCache.keys().next().value;
        if (oldestKey !== undefined) dtoCache.delete(oldestKey);
    }
    dtoCache.set(preflightId, { dto, expiresAt: Date.now() + PRECHECKOUT_BLITE_CACHE_TTL_MS });
}

/** Test-only: clears the in-process DTO cache so specs do not leak state across runs. */
export function __resetPrecheckoutBliteCacheForTest(): void {
    dtoCache.clear();
}

function precheckoutBliteEnabled(): boolean {
    return process.env[PRECHECKOUT_BLITE_ENABLED_FLAG] === 'true';
}

function empty(): NextResponse {
    return new NextResponse(null, { status: 204 });
}

/**
 * This screen sits before login and payment, so most callers arrive with no Supabase
 * session at all. Anonymous access is proven the same way the existing preflight routes
 * prove it (see `app/api/analysis/preflight/[preflightId]/route.ts`'s GET handler): a
 * short-lived signed claim token in `x-preflight-claim-token`, verified server-side by
 * `readAnonymousAnalysisV2Preflight`. Returns `null` on a missing/invalid token or an
 * unrecognized preflight — never throws for that case.
 */
async function anonymousStoredPreflight(
    request: Request,
    preflightId: string,
    client: PreflightSupabaseClient,
): Promise<StoredPreflight | null> {
    const claimToken = request.headers.get('x-preflight-claim-token')?.trim();
    if (!claimToken) return null;
    return readAnonymousAnalysisV2Preflight(preflightId, claimToken, { client });
}

async function handlePOST(request: Request): Promise<NextResponse> {
    // No flag -> 204, before any other work. The flag is never exposed to the browser.
    if (!precheckoutBliteEnabled()) return empty();

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return empty();
    }
    const parsed = requestBodySchema.safeParse(body);
    if (!parsed.success) return empty();
    const { preflightId } = parsed.data;

    try {
        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        const client = supabase as unknown as PreflightSupabaseClient;

        // Resolve the preflight through the existing owner-scoped store (authenticated) or
        // the existing anonymous claim mechanism (no session) so ownership/claim and expiry
        // checks are never bypassed, and require the ready state before doing any paid work
        // below. This is what ties inference cost to a real preflight instead of an
        // arbitrary username.
        const stored = error || !user
            ? await anonymousStoredPreflight(request, preflightId, client)
            : await preflightStore.findForOwner(preflightId, user.id, { client });
        if (!stored || stored.status !== 'ready' || !stored.readySnapshot) return empty();

        // Ownership is confirmed; a cache hit can now short-circuit the paid path.
        const cached = readCachedDto(preflightId);
        if (cached) return NextResponse.json(cached);

        const targetUsername = stored.readySnapshot.target.username;
        const profile = await getInstagramProfile(targetUsername, { requestId: preflightId });
        if (!profile || profile.isPrivate) return empty();
        if (!profile.latestPosts || profile.latestPosts.length === 0) return empty();

        // Short abort/timeout so a slow model call cannot hold the connection open.
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            PRECHECKOUT_BLITE_INFERENCE_TIMEOUT_MS
        );
        let dto: PrecheckoutBliteV1 | null;
        try {
            dto = await inferPrecheckoutBlite(profile, {
                requestId: preflightId,
                abortSignal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }
        if (!dto) return empty();

        // The route re-validates before caching/responding; reject/clamp rather than pass
        // through anything that does not match the contract exactly.
        const revalidated = precheckoutBliteV1Schema.safeParse(dto);
        if (!revalidated.success) return empty();

        writeCachedDto(preflightId, revalidated.data);
        return NextResponse.json(revalidated.data);
    } catch {
        // Never 5xx into the product flow.
        return empty();
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    return handlePOST(request);
}
