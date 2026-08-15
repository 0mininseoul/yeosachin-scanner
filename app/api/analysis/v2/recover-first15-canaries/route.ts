import { NextResponse } from 'next/server';
import {
    runFirst15CanaryProviderRecovery,
} from '@/lib/services/analysis/first15-canary-provider-recovery';
import { isAnalysisV2WorkerAvailable } from '@/lib/services/analysis/v2-execution-gate';
import {
    getAnalysisV2MaintenanceAuthConfig,
    verifyAnalysisV2MaintenanceAuthorization,
} from '@/lib/services/analysis/v2-maintenance-auth';
import { observeRoute } from '@/lib/observability/request';

export const maxDuration = 300;

async function handlePOST(request: Request) {
    let config;
    try {
        config = getAnalysisV2MaintenanceAuthConfig();
    } catch {
        return NextResponse.json({ code: 'MAINTENANCE_UNAVAILABLE' }, { status: 503 });
    }
    if (!await verifyAnalysisV2MaintenanceAuthorization(
        request.headers.get('authorization'),
        { config },
    )) {
        return NextResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    }
    if (!isAnalysisV2WorkerAvailable()) {
        return NextResponse.json({ code: 'V2_PIPELINE_UNAVAILABLE' }, { status: 503 });
    }
    try {
        return NextResponse.json(await runFirst15CanaryProviderRecovery());
    } catch {
        console.error('First15 provider-canary recovery failed.');
        return NextResponse.json({ code: 'FIRST15_CANARY_RECOVERY_FAILED' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    return observeRoute(
        request,
        '/api/analysis/v2/recover-first15-canaries',
        () => handlePOST(request),
    );
}
