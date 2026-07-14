import { NextResponse } from 'next/server';
import { isAnalysisV2RecoveryAvailable } from '@/lib/services/analysis/v2-execution-gate';
import { recoverAnalysisV2Jobs } from '@/lib/services/analysis/v2-recovery';
import {
    getAnalysisV2MaintenanceAuthConfig,
    verifyAnalysisV2MaintenanceAuthorization,
} from '@/lib/services/analysis/v2-maintenance-auth';

export const maxDuration = 300;

export async function POST(request: Request) {
    let config;
    try {
        config = getAnalysisV2MaintenanceAuthConfig();
    } catch {
        return NextResponse.json({ code: 'MAINTENANCE_UNAVAILABLE' }, { status: 503 });
    }
    if (!await verifyAnalysisV2MaintenanceAuthorization(
        request.headers.get('authorization'),
        { config }
    )) {
        return NextResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    }
    if (!isAnalysisV2RecoveryAvailable()) {
        return NextResponse.json({ code: 'V2_PIPELINE_UNAVAILABLE' }, { status: 503 });
    }

    try {
        const summary = await recoverAnalysisV2Jobs();
        return NextResponse.json(summary, { status: summary.failed === 0 ? 200 : 500 });
    } catch {
        console.error('Analysis V2 dispatch recovery failed.');
        return NextResponse.json({ code: 'RECOVERY_FAILED' }, { status: 500 });
    }
}
