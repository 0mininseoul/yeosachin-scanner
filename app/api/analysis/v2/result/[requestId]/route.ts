import { z } from 'zod';
import { NextResponse } from 'next/server';
import { analysisResultPageV1Schema } from '@/lib/contracts/analysis-v2';
import {
    RESULT_PAGE_SIZE_DEFAULT,
    RESULT_PAGE_SIZE_MAX,
    decodeResultCursor,
    type ResultListKind,
} from '@/lib/domain/analysis/result-pagination';
import { analysisV2ResultStore } from '@/lib/services/analysis/v2-result-store';
import { createClient } from '@/lib/supabase/server';

const requestIdSchema = z.string().uuid();
const pageSizeSchema = z.string().regex(/^\d{1,2}$/).transform(Number)
    .pipe(z.number().int().min(1).max(RESULT_PAGE_SIZE_MAX));

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

function parseCursor(value: string | null, list: ResultListKind): string | null {
    if (value === null) return null;
    const cursor = decodeResultCursor(value);
    if (cursor.list !== list) throw new Error('RESULT_CURSOR_SCOPE_MISMATCH');
    return value;
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
    const requestId = requestIdSchema.safeParse((await params).requestId);
    const url = new URL(request.url);
    const pageSize = url.searchParams.has('pageSize')
        ? pageSizeSchema.safeParse(url.searchParams.get('pageSize'))
        : { success: true as const, data: RESULT_PAGE_SIZE_DEFAULT };

    let femaleCursor: string | null;
    let privateCursor: string | null;
    try {
        femaleCursor = parseCursor(url.searchParams.get('femaleCursor'), 'public');
        privateCursor = parseCursor(url.searchParams.get('privateCursor'), 'private');
    } catch {
        return json({ error: 'Invalid result request.' }, 400);
    }
    if (!requestId.success || !pageSize.success) {
        return json({ error: 'Invalid result request.' }, 400);
    }

    try {
        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            return json({ error: 'Authentication required.' }, 401);
        }

        const result = await analysisV2ResultStore.loadPage({
            requestId: requestId.data,
            userId: user.id,
            femaleCursor,
            privateCursor,
            pageSize: pageSize.data,
        });
        if (!result) {
            return json({ error: 'Analysis result not found.' }, 404);
        }

        return json(analysisResultPageV1Schema.parse(result), 200);
    } catch {
        console.error('[analysis-v2-result] owner result read failed');
        return json({ error: 'Result could not be loaded.' }, 500);
    }
}
