import { NextResponse } from 'next/server';
import { isAnalysisV2RecoveryAvailable } from '@/lib/services/analysis/v2-execution-gate';
import { recoverAnalysisV2Jobs } from '@/lib/services/analysis/v2-recovery';
import {
    recoverExpiredProfileProviderCanaries,
} from '@/lib/services/analysis/profile-provider-canary-recovery';
import {
    getAnalysisV2MaintenanceAuthConfig,
    verifyAnalysisV2MaintenanceAuthorization,
} from '@/lib/services/analysis/v2-maintenance-auth';
import {
    purgeConfiguredResultImages,
} from '@/lib/services/media/result-image-purge';

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

    const [generalResult, canaryResult, resultImagePurgeResult] =
        await Promise.allSettled([
            recoverAnalysisV2Jobs(),
            recoverExpiredProfileProviderCanaries(),
            purgeConfiguredResultImages(),
        ]);
    if (
        generalResult.status === 'rejected'
        || canaryResult.status === 'rejected'
        || resultImagePurgeResult.status === 'rejected'
    ) {
        console.error('Analysis V2 dispatch recovery failed.');
        return NextResponse.json({ code: 'RECOVERY_FAILED' }, { status: 500 });
    }
    const summary = generalResult.value;
    const profileProviderCanary = canaryResult.value;
    const resultImagePurge = resultImagePurgeResult.value;
    return NextResponse.json(
        { ...summary, profileProviderCanary, resultImagePurge },
        {
            status: summary.failed === 0
                && profileProviderCanary.failed === 0
                && resultImagePurge.failed === 0
                ? 200
                : 500,
        }
    );
}
