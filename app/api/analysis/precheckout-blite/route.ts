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
import { precheckoutBliteTerminalStore } from '@/lib/services/precheckout/blite-store';
import {
    parseBliteBrowserStatusV1,
    toBliteStatusV1,
} from '@/lib/services/precheckout/blite-status-contract';

export const maxDuration = 15;

const requestBodySchema = z.object({ preflightId: z.string().uuid() }).strict();
const noStoreHeaders = { 'Cache-Control': 'no-store' };

function empty(): NextResponse {
    return new NextResponse(null, { status: 204, headers: noStoreHeaders });
}

function statusResponse(value: unknown, status: number): NextResponse {
    const body = parseBliteBrowserStatusV1(value);
    return body === null
        ? empty()
        : NextResponse.json(body, { status, headers: noStoreHeaders });
}

async function anonymousStoredPreflight(
    request: Request,
    preflightId: string,
    client: PreflightSupabaseClient,
): Promise<StoredPreflight | null> {
    const claimToken = request.headers.get('x-preflight-claim-token')?.trim();
    if (!claimToken) return null;
    return readAnonymousAnalysisV2Preflight(preflightId, claimToken, { client });
}

export async function POST(request: Request): Promise<NextResponse> {
    if (process.env.PRECHECKOUT_BLITE_ENABLED !== 'true') return empty();
    let parsed: z.infer<typeof requestBodySchema>;
    try {
        parsed = requestBodySchema.parse(await request.json());
    } catch {
        return empty();
    }
    try {
        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        const client = supabase as unknown as PreflightSupabaseClient;
        const stored = error || !user
            ? await anonymousStoredPreflight(request, parsed.preflightId, client)
            : await preflightStore.findForOwner(parsed.preflightId, user.id, { client });
        if (!stored) return empty();

        if (stored.status === 'pending' || stored.status === 'processing') {
            return statusResponse({
                state: 'parent_pending',
                parentState: stored.status,
                retryAfterMs: 1_000,
            }, 202);
        }

        const expiresAtMs = Date.parse(stored.expiresAt);
        if (
            stored.status === 'expired'
            || !Number.isFinite(expiresAtMs)
            || expiresAtMs <= Date.now()
        ) {
            return statusResponse({ state: 'expired' }, 410);
        }

        if (stored.status === 'blocked' || stored.status === 'consumed') {
            return statusResponse({ state: 'terminal' }, 200);
        }
        if (stored.status !== 'ready') {
            return empty();
        }
        const durable = await precheckoutBliteTerminalStore.readStatus({
            preflightId: parsed.preflightId,
        });
        if (!durable) return statusResponse({ state: 'unavailable' }, 200);
        const body = parseBliteBrowserStatusV1(toBliteStatusV1(durable));
        if (!body) return empty();
        return NextResponse.json(body, {
            status: body.state === 'pending' ? 202 : 200,
            headers: noStoreHeaders,
        });
    } catch {
        return empty();
    }
}
