import { NextResponse } from 'next/server';
import { runPreflightRetention } from '@/lib/services/analysis/preflight-retention';
import {
    getAnalysisV2MaintenanceAuthConfig,
    verifyAnalysisV2MaintenanceAuthorization,
} from '@/lib/services/analysis/v2-maintenance-auth';

export const maxDuration = 60;

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

    try {
        return NextResponse.json(await runPreflightRetention());
    } catch {
        console.error('Analysis V2 preflight retention failed.');
        return NextResponse.json({ code: 'RETENTION_FAILED' }, { status: 500 });
    }
}
