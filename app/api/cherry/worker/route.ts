import { NextResponse } from 'next/server';
import { z } from 'zod';
import { observeRoute } from '@/lib/observability/request';
import { processTargetCheck } from '@/lib/services/cherry/target-checks';
import { runCherryTick } from '@/lib/services/cherry/worker';
import { readCherryWorkerAuth, verifyCherryWorkerCaller } from '@/lib/services/cherry/worker-auth';

// Vercel never runs this handler; Cloud Run sets its own 600-second request limit.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const TICK_BUDGET_MS = 480_000;
const workSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('tick') }).strict(),
    z.object({ kind: z.literal('target_check'), id: z.string().uuid() }).strict(),
]);

async function handlePOST(request: Request): Promise<NextResponse> {
    const auth = readCherryWorkerAuth();
    if (!auth) return NextResponse.json({ code: 'WORKER_UNAVAILABLE' }, { status: 404 });
    if (!await verifyCherryWorkerCaller(request.headers.get('authorization'), auth)) {
        return NextResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    }
    const work = workSchema.safeParse(await request.json().catch(() => null));
    if (!work.success) return NextResponse.json({ code: 'INVALID_WORK' }, { status: 400 });
    if (work.data.kind === 'target_check') {
        const outcome = await processTargetCheck(work.data.id, Date.now() + 120_000);
        return NextResponse.json({ outcome });
    }
    const summary = await runCherryTick(Date.now() + TICK_BUDGET_MS);
    if (summary.failed.length > 0 || Object.keys((summary.steps.checks ?? {}) as object).length > 0) {
        console.log('CHERRY_TICK', JSON.stringify(summary));
    }
    return NextResponse.json({ failed: summary.failed });
}

export function POST(request: Request): Promise<NextResponse> {
    return observeRoute(request, '/api/cherry/worker', () => handlePOST(request));
}
