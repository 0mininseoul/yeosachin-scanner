import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { isJsonRequest } from '@/lib/services/earlybird/contracts';
import {
    classifyOperatorAuthError,
    getAnalysisAuditOperatorDecision,
} from '@/lib/services/analysis/score-audit';
import {
    createApifyAccountCreditInventoryStore,
    createServerApifyCreditClientFactory,
} from '@/lib/services/analysis/apify-account-credit-inventory';
import {
    APIFY_FREE_CREDENTIAL_SLOTS,
} from '@/lib/services/instagram/providers/types';

export const dynamic = 'force-dynamic';

const APIFY_ACCOUNT_INVENTORY_MAX_AGE_SECONDS = 300;
const MAX_JSON_BODY_BYTES = 4_096;
const uuidSchema = z.string().uuid();
const exclusionSchema = z.object({
    credentialSlot: z.enum(APIFY_FREE_CREDENTIAL_SLOTS),
    excluded: z.boolean(),
}).strict();
const postActionSchema = z.object({
    action: z.literal('refresh-paid-secondary'),
}).strict();

function privateJson(body: unknown, status = 200) {
    return NextResponse.json(body, {
        status,
        headers: { 'Cache-Control': 'private, no-store' },
    });
}

type OperatorAuth =
    | { supabase: Awaited<ReturnType<typeof createClient>> }
    | { response: NextResponse };

async function authenticateOperator(): Promise<OperatorAuth> {
    let supabase: Awaited<ReturnType<typeof createClient>>;
    let user: { id: string } | null = null;
    try {
        supabase = await createClient();
        const auth = await supabase.auth.getUser();
        if (auth.error) {
            if (classifyOperatorAuthError(auth.error) === 'unauthorized') {
                return { response: privateJson({ error: 'Unauthorized' }, 401) };
            }
            return { response: privateJson({ error: 'Authentication unavailable' }, 503) };
        }
        user = auth.data.user;
    } catch (caught) {
        if (classifyOperatorAuthError(caught) === 'unauthorized') {
            return { response: privateJson({ error: 'Unauthorized' }, 401) };
        }
        return { response: privateJson({ error: 'Authentication unavailable' }, 503) };
    }
    if (!user || !uuidSchema.safeParse(user.id).success) {
        return { response: privateJson({ error: 'Unauthorized' }, 401) };
    }
    let operatorDecision: ReturnType<typeof getAnalysisAuditOperatorDecision>;
    try {
        operatorDecision = getAnalysisAuditOperatorDecision(user.id);
    } catch {
        return { response: privateJson({ error: 'Authentication unavailable' }, 503) };
    }
    if (operatorDecision === 'unavailable') {
        return { response: privateJson({ error: 'Authentication unavailable' }, 503) };
    }
    if (operatorDecision === 'forbidden') {
        return { response: privateJson({ error: 'Forbidden' }, 403) };
    }
    return { supabase };
}

function isAuthResponse(value: OperatorAuth): value is { response: NextResponse } {
    return 'response' in value;
}

async function readJsonBody(request: Request): Promise<unknown> {
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
        const parsedLength = z.string()
            .regex(/^\d+$/)
            .transform(Number)
            .refine(value => Number.isSafeInteger(value) && value <= MAX_JSON_BODY_BYTES)
            .safeParse(contentLength);
        if (!parsedLength.success) throw new Error('INVALID_REQUEST_BODY');
    }

    const reader = request.body?.getReader();
    if (!reader) throw new Error('INVALID_REQUEST_BODY');

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) throw new Error('INVALID_REQUEST_BODY');
            totalBytes += value.byteLength;
            if (totalBytes > MAX_JSON_BODY_BYTES) throw new Error('INVALID_REQUEST_BODY');
            chunks.push(value);
        }
    } catch {
        try {
            await reader.cancel();
        } catch {
            // The request is already invalid; preserve the safe boundary error.
        }
        throw new Error('INVALID_REQUEST_BODY');
    } finally {
        reader.releaseLock();
    }

    if (totalBytes === 0) {
        throw new Error('INVALID_REQUEST_BODY');
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new Error('INVALID_REQUEST_BODY');
    }
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
    return schema.parse(value);
}

export async function GET(request: Request) {
    void request;
    const auth = await authenticateOperator();
    if (isAuthResponse(auth)) return auth.response;

    try {
        const store = createApifyAccountCreditInventoryStore(supabaseAdmin);
        const inventory = await store.load(APIFY_ACCOUNT_INVENTORY_MAX_AGE_SECONDS);
        return privateJson({ inventory });
    } catch {
        return privateJson({ error: 'Failed to load Apify account inventory' }, 500);
    }
}

export async function PATCH(request: Request) {
    const auth = await authenticateOperator();
    if (isAuthResponse(auth)) return auth.response;
    if (!isJsonRequest(request)) {
        return privateJson({ error: 'Unsupported Media Type' }, 415);
    }

    let input: z.infer<typeof exclusionSchema>;
    try {
        input = parseBody(exclusionSchema, await readJsonBody(request));
    } catch {
        return privateJson({ error: 'Invalid Apify account exclusion request' }, 400);
    }

    try {
        const store = createApifyAccountCreditInventoryStore(supabaseAdmin);
        await store.setManualExclusion(input);
        const inventory = await store.load(APIFY_ACCOUNT_INVENTORY_MAX_AGE_SECONDS);
        return privateJson({ inventory });
    } catch {
        return privateJson({ error: 'Failed to update Apify account exclusion' }, 500);
    }
}

export async function POST(request: Request) {
    const auth = await authenticateOperator();
    if (isAuthResponse(auth)) return auth.response;
    if (!isJsonRequest(request)) {
        return privateJson({ error: 'Unsupported Media Type' }, 415);
    }

    let action: z.infer<typeof postActionSchema>;
    try {
        action = parseBody(postActionSchema, await readJsonBody(request));
    } catch {
        return privateJson({ error: 'Invalid Apify account action request' }, 400);
    }

    if (action.action !== 'refresh-paid-secondary') {
        return privateJson({ error: 'Invalid Apify account action request' }, 400);
    }

    try {
        const store = createApifyAccountCreditInventoryStore(supabaseAdmin);
        const clientForSlot = createServerApifyCreditClientFactory();
        const secondary = await store.refreshPaidSecondary({
            client: clientForSlot('secondary'),
        });
        const inventory = await store.load(APIFY_ACCOUNT_INVENTORY_MAX_AGE_SECONDS);
        return privateJson({ inventory, secondary });
    } catch {
        return privateJson({ error: 'Failed to refresh paid Apify account' }, 500);
    }
}
