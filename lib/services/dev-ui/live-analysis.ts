import 'server-only';

import type { User } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';
import { DEV_LIVE_STANDARD_CAPS, DEV_LIVE_STANDARD_START_PLAN, DEV_UI_APP_ORIGIN } from '@/lib/constants/dev-ui';
import { preflightRequestV1Schema } from '@/lib/contracts/analysis-v2';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { requireActiveE2eTestRunner } from '@/lib/services/identity/account-principal-store';
import { assertAnalysisTestEntitlementConfiguration } from '@/lib/services/analysis/test-entitlement';
import { devUiJson, withDevUiSession } from './routes';
import {
    DEV_LIVE_OWNER_PREFLIGHT_KEY_PREFIX,
    DEV_LIVE_OWNER_START_ATTEMPT,
    DEV_LIVE_PREFLIGHT_KEY_PREFIX,
    DEV_LIVE_RUNNER_PLAN,
    DEV_LIVE_STANDARD_PREFLIGHT_KEY_PREFIX,
    devLiveApprovalId,
    devLiveOwnerStartEnabled,
    devLiveStandardTarget,
    parseDevLiveOwnerApproval,
    parseDevLiveStandardApproval,
    readDevLiveApproval,
    type DevLiveApproval,
} from './live-approval';
import { assertDevLiveWebRuntime } from './live-runtime';
import { assertDevLiveBudgetAvailable } from './live-budget';

export type { DevLiveApproval } from './live-approval';

const uuid = z.string().uuid();
const persistedKey = new RegExp(`^${DEV_LIVE_PREFLIGHT_KEY_PREFIX}(?:owner:(?:standard:)?)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);

type DevLiveResource = { preflightId: string } | { requestId: string };
const devLivePlanHeader = 'x-dev-live-plan';

export function isDevLiveAnalysisRequest(request: Request): boolean {
    return new URL(request.url).searchParams.getAll('devAnalysis').some(value => value === 'live');
}

function validSelector(request: Request): boolean {
    const selectors = new URL(request.url).searchParams.getAll('devAnalysis');
    return selectors.length === 1 && selectors[0] === 'live';
}

function closed() {
    return devUiJson({ code: 'DEV_LIVE_APPROVAL_REQUIRED', error: '실제 분석 설정을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.' }, 503);
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

export async function isDevLivePreflightBoundToApproval(
    userId: string, preflightId: string, approval: DevLiveApproval,
): Promise<boolean> {
    const preflight = await readLivePreflight(userId, { preflightId });
    return preflight?.idempotency_key === approval.idempotencyKey
        && preflight.target_instagram_id === approval.targetInstagramId;
}

function privateResponse(response: NextResponse): NextResponse {
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    response.headers.set('x-analytics-eligible', '0');
    return response;
}

async function requireLiveWebAccess(user: User): Promise<void> {
    assertDevLiveWebRuntime();
    assertAnalysisTestEntitlementConfiguration();
    await requireActiveE2eTestRunner(user, DEV_LIVE_RUNNER_PLAN);
}

type OwnerStartRpc = `dev_live_owner_start${'' | '_lookup' | '_ready'}_v${1 | 2 | 3}`;

async function ownerStartRpc(name: OwnerStartRpc, args?: Record<string, string>): Promise<unknown> {
    const { data, error } = await supabaseAdmin.rpc(name, args);
    if (error) {
        if ((name === 'dev_live_owner_start_v1' || name === 'dev_live_owner_start_v3') && error.code === 'P0001'
            && error.message === 'DEV_LIVE_OWNER_START_UNAVAILABLE') {
            throw new Error('DEV_LIVE_START_ATTEMPT_EXPIRED');
        }
        throw new Error('DEV_LIVE_OWNER_START_UNAVAILABLE');
    }
    return data;
}

async function ownerApprovalForPreflight(preflight: { idempotency_key: string; target_instagram_id: string }, userId: string) {
    if (!preflight.idempotency_key.startsWith(DEV_LIVE_OWNER_PREFLIGHT_KEY_PREFIX)) return null;
    const standard = preflight.idempotency_key.startsWith(DEV_LIVE_STANDARD_PREFLIGHT_KEY_PREFIX);
    const standardTarget = devLiveStandardTarget();
    if (standard && standardTarget !== preflight.target_instagram_id) return null;
    const prefix = standard ? DEV_LIVE_STANDARD_PREFLIGHT_KEY_PREFIX : DEV_LIVE_OWNER_PREFLIGHT_KEY_PREFIX;
    const descriptor = await ownerStartRpc(standard ? 'dev_live_owner_start_lookup_v2' : 'dev_live_owner_start_lookup_v1', {
        p_grant_id: preflight.idempotency_key.slice(prefix.length),
        p_user_id: userId,
        p_target_instagram_id: preflight.target_instagram_id,
    });
    const approval = standard
        ? parseDevLiveStandardApproval(descriptor, preflight.target_instagram_id)
        : parseDevLiveOwnerApproval(descriptor);
    if (approval?.idempotencyKey !== preflight.idempotency_key || approval.targetInstagramId !== preflight.target_instagram_id) return null;
    return approval;
}

async function issueOwnerApproval(user: User, request: Request): Promise<DevLiveApproval | null> {
    const attempt = devLiveApprovalId.safeParse(request.headers.get(DEV_LIVE_OWNER_START_ATTEMPT));
    if (!attempt.success) return null;
    const body = await request.clone().json().catch(() => null);
    const input = preflightRequestV1Schema.safeParse(body);
    if (!input.success) return null;
    const standard = devLiveStandardTarget() === input.data.targetInstagramId;
    const acknowledgedPlan = request.headers.get(devLivePlanHeader);
    if (standard
        ? acknowledgedPlan !== DEV_LIVE_STANDARD_START_PLAN
        : acknowledgedPlan !== null && acknowledgedPlan !== 'basic') {
        throw new Error('DEV_LIVE_PLAN_CHANGED');
    }
    const descriptor = await ownerStartRpc(standard ? 'dev_live_owner_start_v3' : 'dev_live_owner_start_v1', {
        p_user_id: user.id,
        p_target_instagram_id: input.data.targetInstagramId,
        p_attempt_id: attempt.data,
    });
    const approval = standard
        ? parseDevLiveStandardApproval(descriptor, input.data.targetInstagramId)
        : parseDevLiveOwnerApproval(descriptor);
    if (standard && approval?.aiMaxCents !== DEV_LIVE_STANDARD_CAPS.aiMaxCents) return null;
    return approval?.targetInstagramId === input.data.targetInstagramId ? approval : null;
}

/** Only an authenticated owner start may issue a new per-run approval. */
export function withDevLiveApproval(
    request: Request,
    operation: (user: User, approval: DevLiveApproval) => Promise<NextResponse>,
    preflightId?: string,
): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        if (!validSelector(request)) return notFound();
        const ownerStart = devLiveOwnerStartEnabled();
        if (ownerStart && request.headers.get('origin') !== DEV_UI_APP_ORIGIN) return notFound();
        let approval: DevLiveApproval | null;
        try {
            await requireLiveWebAccess(user);
            if (ownerStart && preflightId === undefined) {
                if (request.method !== 'POST') return notFound();
                approval = await issueOwnerApproval(user, request);
            } else if (ownerStart && preflightId !== undefined) {
                const preflight = await readLivePreflight(user.id, { preflightId });
                if (!preflight) return notFound();
                approval = await ownerApprovalForPreflight(preflight, user.id);
                if (!approval) return devUiJson({
                    code: 'DEV_LIVE_RUN_EXPIRED',
                    error: '이 실행을 계속할 수 없습니다. 새 실제 분석을 시작해 주세요.',
                }, 410);
            } else {
                approval = readDevLiveApproval();
                if (approval && preflightId !== undefined) {
                    const preflight = await readLivePreflight(user.id, { preflightId });
                    if (preflight?.idempotency_key !== approval.idempotencyKey
                        || preflight.target_instagram_id !== approval.targetInstagramId) return notFound();
                }
            }
            if (!approval) return closed();
            await assertDevLiveBudgetAvailable(approval);
        } catch (error) {
            if (error instanceof Error && error.message === 'DEV_LIVE_PLAN_CHANGED') {
                return devUiJson({
                    code: 'DEV_LIVE_PLAN_CHANGED',
                    error: '분석 플랜이나 예산이 바뀌었습니다. 페이지를 새로고침하고 예산을 확인해 주세요.',
                }, 409);
            }
            if (error instanceof Error && error.message === 'DEV_LIVE_START_ATTEMPT_EXPIRED') {
                return devUiJson({ code: 'DEV_LIVE_START_ATTEMPT_EXPIRED',
                    error: '이전 실행이 만료되었습니다. 시작 버튼을 다시 눌러 주세요.' }, 410);
            }
            return closed();
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
        if (!validSelector(request)) return notFound();
        const preflight = await readLivePreflight(user.id, resource);
        if (!preflight) return notFound();
        const response = privateResponse(await operation(user));
        if ('preflightId' in resource) {
            response.headers.set(devLivePlanHeader,
                preflight.idempotency_key.startsWith(DEV_LIVE_STANDARD_PREFLIGHT_KEY_PREFIX) ? 'standard' : 'basic');
        }
        return response;
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
            await requireLiveWebAccess(user);
            if (devLiveOwnerStartEnabled()) {
                const available = await ownerStartRpc('dev_live_owner_start_ready_v1', { p_user_id: user.id }) === true;
                const target = available ? devLiveStandardTarget() : null;
                const standardReady = target && await ownerStartRpc('dev_live_owner_start_ready_v3', {
                    p_user_id: user.id, p_target_instagram_id: target,
                }).catch(() => false) === true;
                return devUiJson({
                    available, recentPreflightId,
                    ...(target ? { standardTarget: target, standardAvailable: standardReady === true } : {}),
                });
            }
            const approval = readDevLiveApproval();
            if (!approval) return devUiJson({ available: false, recentPreflightId });
            await assertDevLiveBudgetAvailable(approval);
            return devUiJson({ available: true, recentPreflightId });
        } catch {
            return devUiJson({ available: false, recentPreflightId });
        }
    });
}

/** Worker callers verify delivery identity before looking up the approval and owner. */
export async function getApprovedDevLiveDelivery(resource: DevLiveResource): Promise<DevLiveApproval | null> {
    const ownerStart = devLiveOwnerStartEnabled();
    const legacyApproval = ownerStart ? null : readDevLiveApproval();
    const id = 'preflightId' in resource ? resource.preflightId : resource.requestId;
    if ((!ownerStart && !legacyApproval) || !uuid.safeParse(id).success) return null;
    try {
        let query = supabaseAdmin.from('analysis_preflights').select('id, user_id, idempotency_key, target_instagram_id')
            .eq('access_mode', 'test_entitlement');
        query = 'preflightId' in resource ? query.eq('id', id) : query.eq('consumed_request_id', id);
        const preflight = await query.maybeSingle();
        if (preflight.error || !preflight.data?.user_id) return null;
        const approval = ownerStart
            ? await ownerApprovalForPreflight(preflight.data, preflight.data.user_id)
            : (legacyApproval && preflight.data.idempotency_key === legacyApproval.idempotencyKey
                && preflight.data.target_instagram_id === legacyApproval.targetInstagramId ? legacyApproval : null);
        if (!approval) return null;
        if ('requestId' in resource) {
            const request = await supabaseAdmin.from('analysis_requests').select('id, selected_plan_id_snapshot').eq('id', id)
                .eq('user_id', preflight.data.user_id).eq('preflight_id', preflight.data.id)
                .eq('pipeline_version', 'v2').maybeSingle();
            if (request.error || request.data?.selected_plan_id_snapshot !== approval.planId) return null;
        }
        return approval;
    } catch {
        return null;
    }
}
