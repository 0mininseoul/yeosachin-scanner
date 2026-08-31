import { NextResponse } from 'next/server';
import { observeRoute } from '@/lib/observability/request';
import {
    getPreflightMaintenanceAuthConfig,
    verifyAnalysisV2MaintenanceAuthorization,
} from '@/lib/services/analysis/v2-maintenance-auth';
import { assertAnalysisWorkerWorkloadRole } from '@/lib/services/analysis/workload-role';
import { recoverAnalysisCapacityDispatches } from '@/lib/services/analysis/capacity-dispatch-recovery';
import { isPreflightRecoveryAvailable } from '@/lib/services/analysis/v2-execution-gate';

export const maxDuration = 300;

async function handlePOST(request: Request): Promise<Response> {
    let authConfig;
    try {
        authConfig = getPreflightMaintenanceAuthConfig();
        assertAnalysisWorkerWorkloadRole('preflight');
    } catch {
        return NextResponse.json({ code: 'MAINTENANCE_UNAVAILABLE' }, { status: 503 });
    }
    if (!await verifyAnalysisV2MaintenanceAuthorization(
        request.headers.get('authorization'),
        { config: authConfig },
    )) {
        return NextResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    }
    if (!isPreflightRecoveryAvailable()) {
        return NextResponse.json({ code: 'PREFLIGHT_RECOVERY_UNAVAILABLE' }, { status: 503 });
    }
    try {
        const summary = await recoverAnalysisCapacityDispatches({
            workloadRole: 'preflight',
        });
        return NextResponse.json(summary, {
            status: summary.failed === 0 ? 200 : 500,
        });
    } catch {
        return NextResponse.json({ code: 'RECOVERY_FAILED' }, { status: 500 });
    }
}

export async function POST(request: Request): Promise<Response> {
    return observeRoute(
        request,
        '/api/analysis/preflight/recover',
        () => handlePOST(request),
    );
}
