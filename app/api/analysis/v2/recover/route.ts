import { NextResponse } from 'next/server';
import { isAnalysisV2StartAvailable } from '@/lib/services/analysis/v2-execution-gate';
import { recoverAnalysisV2Jobs } from '@/lib/services/analysis/v2-recovery';
import {
    getAnalysisV2TasksConfig,
    verifyAnalysisV2TaskAuthorization,
} from '@/lib/services/analysis/v2-tasks';

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
    if (!isAnalysisV2StartAvailable()) {
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
