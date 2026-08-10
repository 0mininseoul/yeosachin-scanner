import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadAccountClassification } from '@/lib/services/identity/account-principal-store';
import { isAnalysisResultOperator, resolveAnalysisResultOwner } from '@/lib/services/analysis/result-operator-access';
import { shareObservationEvent } from '@/lib/services/share/share-observation';
import { operationalLogger } from '@/lib/observability/server';

const bodySchema = z.object({
    requestId: z.string().uuid(),
    channel: z.enum(['clipboard', 'web_share', 'kakao']),
    outcome: z.enum(['started', 'succeeded', 'cancelled', 'failed']),
    clientNonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
}).strict();

function json(status: number, body: Record<string, unknown>) {
    return NextResponse.json(body, { status });
}

function sameOrigin(request: Request): boolean {
    const secFetchSite = request.headers.get('sec-fetch-site');
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'same-site' && secFetchSite !== 'none') return false;
    const origin = request.headers.get('origin');
    if (!origin) return true;
    try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export async function POST(request: Request): Promise<NextResponse> {
    if (!sameOrigin(request)) return json(403, { code: 'ORIGIN_REJECTED' });
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json(401, { code: 'UNAUTHORIZED' });
    let raw: unknown;
    try { raw = await request.json(); } catch { return json(400, { code: 'INVALID_REQUEST' }); }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return json(400, { code: 'INVALID_REQUEST' });
    const observation = shareObservationEvent(parsed.data);
    const ownerId = await resolveAnalysisResultOwner(observation.requestId);
    const admin = isAnalysisResultOperator({ id: user.id, email: user.email });
    if ((!ownerId || ownerId !== user.id) && !admin) return json(403, { code: 'FORBIDDEN' });
    const classification = await loadAccountClassification(ownerId ?? user.id);
    if (!classification) return json(403, { code: 'ACCOUNT_ADMISSION_DENIED' });
    const inserted = await supabaseAdmin.from('analysis_result_share_observations').insert({
        request_id: observation.requestId,
        client_nonce: parsed.data.clientNonce,
        share_channel: observation.shareChannel,
        share_outcome: observation.shareOutcome,
        event_name: observation.event,
        traffic_class: classification.trafficClass,
    });
    if (inserted.error && inserted.error.code !== '23505') return json(503, { code: 'OBSERVATION_UNAVAILABLE' });
    operationalLogger.emit({
        event: observation.event,
        severity: 'info',
        fields: {
            request_id: observation.requestId,
            share_channel: observation.shareChannel,
            share_outcome: observation.shareOutcome,
            traffic_class: classification.trafficClass,
            route: '/api/share/observe',
        },
    });
    return json(202, { accepted: true });
}
