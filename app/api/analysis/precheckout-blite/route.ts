import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DEV_UI_APP_ORIGIN } from '@/lib/constants/dev-ui';
import { createClient } from '@/lib/supabase/server';
import { isDevLiveAnalysisRequest, withDevLiveRead } from '@/lib/services/dev-ui/live-analysis';
import { shouldHandleDevUiRequest } from '@/lib/services/dev-ui/routes';
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
    const live = isDevLiveAnalysisRequest(request);
    if (!live && process.env.PRECHECKOUT_BLITE_ENABLED !== 'true') return empty();
    let parsed: z.infer<typeof requestBodySchema>;
    try {
        parsed = requestBodySchema.parse(await request.json());
    } catch {
        return empty();
    }
    try {
        if (live) {
            if (request.headers.get('origin') !== DEV_UI_APP_ORIGIN) return empty();
            return await withDevLiveRead(request, { preflightId: parsed.preflightId },
                user => readStatus(request, parsed.preflightId, user.id));
        }
        if (shouldHandleDevUiRequest(request)) return empty();
        return await readStatus(request, parsed.preflightId);
    } catch {
        return empty();
    }
}

async function readStatus(request: Request, preflightId: string, verifiedDevUserId?: string) {
    const supabase = await createClient();
    const client = supabase as unknown as PreflightSupabaseClient;
    let userId = verifiedDevUserId;
    if (!userId) {
        const { data: { user }, error } = await supabase.auth.getUser();
        userId = error ? undefined : user?.id;
    }
    const stored = userId
        ? await preflightStore.findForOwner(preflightId, userId, { client })
        : await anonymousStoredPreflight(request, preflightId, client);
    if (!stored) return empty();

    const expiresAtMs = Date.parse(stored.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return empty();
    if (stored.status === 'expired' || expiresAtMs <= Date.now()) {
        return statusResponse({ state: 'expired' }, 410);
    }

    if (stored.status === 'pending' || stored.status === 'processing') {
        return statusResponse({
            state: 'parent_pending',
            parentState: stored.status,
            retryAfterMs: 1_000,
        }, 202);
    }

    if (stored.status === 'blocked' || stored.status === 'consumed') {
        return statusResponse({ state: 'terminal' }, 200);
    }
    if (stored.status !== 'ready') {
        return empty();
    }
    if (verifiedDevUserId && process.env.PRECHECKOUT_BLITE_ENABLED !== 'true') {
        return statusResponse({ state: 'unavailable' }, 200);
    }
    const durable = await precheckoutBliteTerminalStore.readStatus({
        preflightId,
    });
    if (!durable) return statusResponse({ state: 'unavailable' }, 200);
    const body = parseBliteBrowserStatusV1(toBliteStatusV1(durable));
    if (!body) return empty();
    return NextResponse.json(body, {
        status: body.state === 'pending' ? 202 : 200,
        headers: noStoreHeaders,
    });
}
