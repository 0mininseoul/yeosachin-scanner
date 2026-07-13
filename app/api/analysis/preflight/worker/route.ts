import { NextResponse } from 'next/server';
import { z } from 'zod';
import { processPreflight } from '@/lib/services/analysis/preflight';
import {
    getPreflightTasksConfig,
    verifyPreflightTaskAuthorization,
} from '@/lib/services/analysis/preflight-tasks';

const workerRequestSchema = z.object({
    preflightId: z.string().uuid(),
}).strict();

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
        const outcome = await processPreflight(parsed.data.preflightId);
        return NextResponse.json({ status: outcome });
    } catch {
        console.error('Preflight worker failed.');
        return NextResponse.json({ code: 'ANALYSIS_FAILED' }, { status: 500 });
    }
}
