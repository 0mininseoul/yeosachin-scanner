import { NextResponse } from 'next/server';
import { getLegacyAnalysisPublicReadiness } from '@/lib/services/analysis/legacy-analysis-public-readiness';

export const dynamic = 'force-dynamic';

/**
 * Non-mutating production observation for the public V1 producer freeze.
 * It does not authenticate, create a client, inspect a user, or touch a
 * queue/provider, so probing it cannot enqueue work if the gate is open.
 */
export async function GET() {
    const readiness = getLegacyAnalysisPublicReadiness();
    return NextResponse.json(readiness, {
        status: readiness.ready ? 200 : 503,
        headers: {
            'cache-control': 'no-store',
        },
    });
}
