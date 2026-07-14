import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { isAnalysisV2WorkerAvailable } from '@/lib/services/analysis/v2-execution-gate';
import {
    AnalysisV2JobDispatchNotReadyError,
    AnalysisV2JobFenceError,
    AnalysisV2JobLeaseBusyError,
} from '@/lib/services/analysis/v2-job-store';
import {
    getAnalysisV2TasksConfig,
    parseAnalysisV2TaskPayload,
    verifyAnalysisV2TaskAuthorization,
} from '@/lib/services/analysis/v2-tasks';
import { processAnalysisV2TaskDelivery } from '@/lib/services/analysis/v2-worker';

export const maxDuration = 300;

export async function POST(request: Request) {
    let config;
    try {
        config = getAnalysisV2TasksConfig();
    } catch {
        return NextResponse.json({ code: 'QUEUE_UNAVAILABLE' }, { status: 503 });
    }
    if (!config || !await verifyAnalysisV2TaskAuthorization(
        request.headers.get('authorization'),
        { config }
    )) {
        return NextResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    }
    if (!isAnalysisV2WorkerAvailable()) {
        return NextResponse.json({ code: 'V2_PIPELINE_UNAVAILABLE' }, { status: 503 });
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ code: 'INVALID_REQUEST' }, { status: 400 });
    }

    try {
        const outcome = await processAnalysisV2TaskDelivery(
            parseAnalysisV2TaskPayload(body)
        );
        if (outcome.status === 'retry') {
            return NextResponse.json({ code: outcome.errorCode }, { status: 500 });
        }
        return NextResponse.json(outcome);
    } catch (error) {
        if (error instanceof ZodError) {
            return NextResponse.json({ code: 'INVALID_REQUEST' }, { status: 400 });
        }
        if (error instanceof AnalysisV2JobFenceError) {
            return NextResponse.json({ status: 'stale_delivery' });
        }
        if (error instanceof AnalysisV2JobDispatchNotReadyError) {
            return NextResponse.json({ code: 'JOB_DISPATCH_NOT_READY' }, { status: 409 });
        }
        if (error instanceof AnalysisV2JobLeaseBusyError) {
            return NextResponse.json({ code: 'JOB_LEASE_BUSY' }, { status: 409 });
        }
        console.error('Analysis V2 worker failed.');
        return NextResponse.json({ code: 'ANALYSIS_FAILED' }, { status: 500 });
    }
}
