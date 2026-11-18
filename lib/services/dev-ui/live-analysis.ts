import 'server-only';

import type { User } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { requireActiveE2eTestRunner } from '@/lib/services/identity/account-principal-store';
import { assertAnalysisTestEntitlementConfiguration } from '@/lib/services/analysis/test-entitlement';
import { devUiJson, withDevUiSession } from './routes';
import { DEV_LIVE_PLAN, DEV_LIVE_PREFLIGHT_KEY_PREFIX, readDevLiveApproval, type DevLiveApproval } from './live-approval';
import { assertDevLiveWebRuntime } from './live-runtime';
import { assertDevLiveBudgetAvailable } from './live-budget';

export type { DevLiveApproval } from './live-approval';

const uuid = z.string().uuid();
const persistedKey = new RegExp(`^${DEV_LIVE_PREFLIGHT_KEY_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);

type DevLiveResource = { preflightId: string } | { requestId: string };

export function isDevLiveAnalysisRequest(request: Request): boolean {
    return new URL(request.url).searchParams.getAll('devAnalysis').some(value => value === 'live');
}

function validSelector(request: Request): boolean {
    const selectors = new URL(request.url).searchParams.getAll('devAnalysis');
    return selectors.length === 1 && selectors[0] === 'live';
}

function closed() {
    return devUiJson({ code: 'DEV_LIVE_APPROVAL_REQUIRED', error: '실제 분석은 실행 예산 승인과 Dev 설정 확인 후 이용할 수 있습니다.' }, 503);
}

function notFound() {
    return devUiJson({ code: 'DEV_LIVE_NOT_FOUND', error: '이 계정의 실제 테스트 요청을 찾을 수 없습니다.' }, 404);
}

async function readLivePreflight(userId: string, resource: DevLiveResource) {
    const id = 'preflightId' in resource ? resource.preflightId : resource.requestId;
    if (!uuid.safeParse(id).success) return null;
    let query = supabaseAdmin.from('analysis_preflights')
        .select('id, idempotency_key, target_instagram_id, consumed_request_id')
        .eq('user_id', userId)
        .eq('access_mode', 'test_entitlement');
    query = 'preflightId' in resource ? query.eq('id', id) : query.eq('consumed_request_id', id);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error('DEV_LIVE_LOOKUP_UNAVAILABLE');
    if (!data || typeof data.idempotency_key !== 'string' || !persistedKey.test(data.idempotency_key)) return null;
    if ('requestId' in resource) {
        const request = await supabaseAdmin.from('analysis_requests').select('id').eq('id', id)
            .eq('user_id', userId).eq('preflight_id', data.id).eq('pipeline_version', 'v2').maybeSingle();
        if (request.error) throw new Error('DEV_LIVE_LOOKUP_UNAVAILABLE');
        if (!request.data) return null;
    }
    return data;
}

export async function isDevLiveRequestOwnedBy(userId: string, requestId: string): Promise<boolean> {
    return !!await readLivePreflight(userId, { requestId });
}

function privateResponse(response: NextResponse): NextResponse {
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    response.headers.set('x-analytics-eligible', '0');
    return response;
}

async function usableApproval(): Promise<DevLiveApproval | null> {
    const approval = readDevLiveApproval();
    if (!approval) return null;
    assertDevLiveWebRuntime();
    assertAnalysisTestEntitlementConfiguration();
    await assertDevLiveBudgetAvailable(approval);
    return approval;
}

/** Mutation gate. The configured grant supplies the one fixed idempotency key and entitlement nonce. */
export function withDevLiveApproval(
    request: Request,
    operation: (user: User, approval: DevLiveApproval) => Promise<NextResponse>,
    preflightId?: string,
): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        if (!validSelector(request)) return notFound();
        let approval: DevLiveApproval | null;
        try {
            approval = await usableApproval();
            if (!approval) return closed();
            await requireActiveE2eTestRunner(user, DEV_LIVE_PLAN);
        } catch {
            return closed();
        }
        if (preflightId !== undefined) {
            const preflight = await readLivePreflight(user.id, { preflightId });
            if (preflight?.idempotency_key !== approval.idempotencyKey
                || preflight.target_instagram_id !== approval.targetInstagramId) return notFound();
        }
        return privateResponse(await operation(user, approval));
    });
}

/** Previously approved results remain readable after the execution window closes. */
export function withDevLiveRead(
    request: Request,
    resource: DevLiveResource,
    operation: (user: User) => Promise<NextResponse>,
): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        if (!validSelector(request) || !await readLivePreflight(user.id, resource)) return notFound();
        return privateResponse(await operation(user));
    });
}

export function handleDevLiveAvailability(request: Request): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        const recent = await supabaseAdmin.from('analysis_preflights').select('id, idempotency_key')
            .eq('user_id', user.id).eq('access_mode', 'test_entitlement')
            .like('idempotency_key', `${DEV_LIVE_PREFLIGHT_KEY_PREFIX}%`)
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
        const recentPreflightId = !recent.error && recent.data && persistedKey.test(recent.data.idempotency_key)
            ? recent.data.id : null;
        try {
            const approval = await usableApproval();
            if (!approval) return devUiJson({ available: false, recentPreflightId });
            await requireActiveE2eTestRunner(user, DEV_LIVE_PLAN);
            return devUiJson({ available: true, recentPreflightId });
        } catch {
            return devUiJson({ available: false, recentPreflightId });
        }
    });
}

/** Worker callers must verify the delivery identity before consulting this grant. */
export async function isApprovedDevLiveDelivery(resource: DevLiveResource): Promise<boolean> {
    const approval = readDevLiveApproval();
    const id = 'preflightId' in resource ? resource.preflightId : resource.requestId;
    if (!approval || !uuid.safeParse(id).success) return false;
    try {
        let query = supabaseAdmin.from('analysis_preflights').select('id, user_id')
            .eq('access_mode', 'test_entitlement')
            .eq('idempotency_key', approval.idempotencyKey)
            .eq('target_instagram_id', approval.targetInstagramId);
        query = 'preflightId' in resource ? query.eq('id', id) : query.eq('consumed_request_id', id);
        const preflight = await query.maybeSingle();
        if (preflight.error || !preflight.data?.user_id) return false;
        if ('requestId' in resource) {
            const request = await supabaseAdmin.from('analysis_requests').select('id').eq('id', id)
                .eq('user_id', preflight.data.user_id).eq('preflight_id', preflight.data.id)
                .eq('pipeline_version', 'v2').maybeSingle();
            return !request.error && !!request.data;
        }
        return true;
    } catch {
        return false;
    }
}
