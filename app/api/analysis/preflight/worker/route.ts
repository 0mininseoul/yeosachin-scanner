import { NextResponse } from 'next/server';
import { z } from 'zod';
import { processPreflight } from '@/lib/services/analysis/preflight';
import { processAnalysisV2FreshAdmission } from '@/lib/services/analysis/fresh-plan-admission';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    getPreflightTasksConfig,
    verifyPreflightTaskAuthorization,
} from '@/lib/services/analysis/preflight-tasks';

const workerRequestSchema = z.union([
    z.object({
        preflightId: z.string().uuid(),
    }).strict(),
    z.object({
        preflightId: z.string().uuid(),
        kind: z.literal('fresh_admission'),
        generation: z.number().int().min(1).max(100),
        dispatchGeneration: z.number().int().min(1).max(100),
        dispatchToken: z.string().uuid(),
    }).strict(),
]);

export async function POST(request: Request) {
    let config;
    try {
        config = getPreflightTasksConfig();
    } catch {
        return NextResponse.json({ code: 'QUEUE_UNAVAILABLE' }, { status: 503 });
    }
    if (!config || !await verifyPreflightTaskAuthorization(
        request.headers.get('authorization'),
        { config }
    )) {
        return NextResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ code: 'INVALID_REQUEST' }, { status: 400 });
    }
    const parsed = workerRequestSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ code: 'INVALID_REQUEST' }, { status: 400 });
    }

    try {
        const outcome = 'kind' in parsed.data
            ? await processAnalysisV2FreshAdmission(supabaseAdmin, {
                preflightId: parsed.data.preflightId,
                generation: parsed.data.generation,
                dispatchGeneration: parsed.data.dispatchGeneration,
                dispatchToken: parsed.data.dispatchToken,
            })
            : await processPreflight(parsed.data.preflightId);
        return NextResponse.json({ status: outcome });
    } catch {
        console.error('Preflight worker failed.');
        return NextResponse.json({ code: 'ANALYSIS_FAILED' }, { status: 500 });
    }
}
