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
import { isAnalysisV2WorkerErrorCode } from '@/lib/services/analysis/v2-worker-error-codes';

export const maxDuration = 300;

const OBSERVABLE_JOB_KEY_PATTERN = /^(?:coordinator:(?:bootstrap|candidate-screening|finalize|join:(?:primary-evidence|final-score))|track:(?:relationships:collect|target-evidence:collect|profiles:batch:[0-9]+|profile-ai:batch:[0-9]+|private-names:batch:[0-9]+|reverse-likes:collect|partner-safety:batch:0|narratives:batch:0))$/;

type WorkerLogDisposition = 'success' | 'transient' | 'permanent' | 'fence';
type WorkerLogOutcome =
    | 'already_terminal'
    | 'completed'
    | 'error'
    | 'failed'
    | 'rejected'
    | 'retry'
    | 'stale_delivery';

function safeErrorCode(value: unknown, fallback: string): string {
    return isAnalysisV2WorkerErrorCode(value)
        ? value
        : fallback;
}

function observableJobKey(value: unknown): string | null {
    return typeof value === 'string' && OBSERVABLE_JOB_KEY_PATTERN.test(value)
        ? value
        : null;
}

function logWorkerOutcome(input: {
    jobKey: string | null;
    outcome: WorkerLogOutcome;
    disposition: WorkerLogDisposition;
    errorCode?: string;
}): void {
    const line = JSON.stringify({
        schemaVersion: 1,
        event: 'analysis_v2_worker',
        jobKey: input.jobKey,
        outcome: input.outcome,
        disposition: input.disposition,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    });
    if (input.disposition === 'success') {
        console.info(line);
    } else if (input.disposition === 'transient') {
        console.warn(line);
    } else {
        console.error(line);
    }
}

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

    let delivery;
    try {
        delivery = parseAnalysisV2TaskPayload(body);
    } catch (error) {
        if (error instanceof ZodError) {
            logWorkerOutcome({
                jobKey: null,
                outcome: 'rejected',
                disposition: 'permanent',
                errorCode: 'INVALID_REQUEST',
            });
            return NextResponse.json({ code: 'INVALID_REQUEST' }, { status: 400 });
        }
        logWorkerOutcome({
            jobKey: null,
            outcome: 'error',
            disposition: 'transient',
            errorCode: 'ANALYSIS_V2_WORKER_UNHANDLED_ERROR',
        });
        return NextResponse.json({ code: 'ANALYSIS_FAILED' }, { status: 500 });
    }

    const jobKey = observableJobKey(delivery.jobKey);
    try {
        const outcome = await processAnalysisV2TaskDelivery(delivery);
        if (outcome.status === 'retry') {
            const errorCode = safeErrorCode(
                outcome.errorCode,
                'ANALYSIS_V2_JOB_HANDLER_FAILED'
            );
            logWorkerOutcome({ jobKey, outcome: 'retry', disposition: 'transient', errorCode });
            return NextResponse.json({ code: errorCode }, { status: 500 });
        }
        if (outcome.status === 'failed') {
            const errorCode = safeErrorCode(
                outcome.errorCode,
                'ANALYSIS_V2_JOB_HANDLER_FAILED'
            );
            logWorkerOutcome({ jobKey, outcome: 'failed', disposition: 'permanent', errorCode });
            return NextResponse.json({ status: 'failed', errorCode });
        }
        logWorkerOutcome({ jobKey, outcome: outcome.status, disposition: 'success' });
        return NextResponse.json(outcome);
    } catch (error) {
        if (error instanceof AnalysisV2JobFenceError) {
            logWorkerOutcome({
                jobKey,
                outcome: 'stale_delivery',
                disposition: 'fence',
                errorCode: 'ANALYSIS_V2_JOB_FENCE_MISMATCH',
            });
            return NextResponse.json({ status: 'stale_delivery' });
        }
        if (error instanceof AnalysisV2JobDispatchNotReadyError) {
            logWorkerOutcome({
                jobKey,
                outcome: 'retry',
                disposition: 'transient',
                errorCode: 'JOB_DISPATCH_NOT_READY',
            });
            return NextResponse.json({ code: 'JOB_DISPATCH_NOT_READY' }, { status: 409 });
        }
        if (error instanceof AnalysisV2JobLeaseBusyError) {
            logWorkerOutcome({
                jobKey,
                outcome: 'retry',
                disposition: 'transient',
                errorCode: 'JOB_LEASE_BUSY',
            });
            return NextResponse.json({ code: 'JOB_LEASE_BUSY' }, { status: 409 });
        }
        logWorkerOutcome({
            jobKey,
            outcome: 'error',
            disposition: 'transient',
            errorCode: 'ANALYSIS_V2_WORKER_UNHANDLED_ERROR',
        });
        return NextResponse.json({ code: 'ANALYSIS_FAILED' }, { status: 500 });
    }
}
