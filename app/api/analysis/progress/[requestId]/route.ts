import { z } from 'zod';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ANALYSIS_V2_SCHEMA_VERSION, progressReadV1Schema } from '@/lib/contracts/analysis-v2';
import { analysisV2ProgressStore } from '@/lib/services/analysis/v2-progress-store';

const requestIdSchema = z.string().uuid();
const sequenceSchema = z.string().regex(/^\d{1,16}$/).transform(Number)
    .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const limitSchema = z.string().regex(/^\d{1,3}$/).transform(Number)
    .pipe(z.number().int().min(1).max(200));

const PRIVATE_NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
} as const;

function json(body: unknown, status: number) {
    return NextResponse.json(body, {
        status,
        headers: PRIVATE_NO_STORE_HEADERS,
    });
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
    try {
        const requestId = requestIdSchema.safeParse((await params).requestId);
        const url = new URL(request.url);
        const afterSequence = url.searchParams.has('afterSeq')
            ? sequenceSchema.safeParse(url.searchParams.get('afterSeq'))
            : { success: true as const, data: 0 };
        const eventLimit = url.searchParams.has('limit')
            ? limitSchema.safeParse(url.searchParams.get('limit'))
            : { success: true as const, data: 100 };
        if (!requestId.success || !afterSequence.success || !eventLimit.success) {
            return json({ error: 'Invalid progress request.' }, 400);
        }

        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            return json({ error: 'Authentication required.' }, 401);
        }

        const progress = await analysisV2ProgressStore.loadForOwner({
            requestId: requestId.data,
            userId: user.id,
            afterSequence: afterSequence.data,
            eventLimit: eventLimit.data,
        });
        if (!progress) {
            return json({ error: 'Analysis progress not found.' }, 404);
        }

        const response = progressReadV1Schema.parse({
            schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
            ...progress,
        });
        return json(response, 200);
    } catch {
        console.error('[analysis-v2-progress] owner progress read failed');
        return json({ error: 'Progress could not be loaded.' }, 500);
    }
}
