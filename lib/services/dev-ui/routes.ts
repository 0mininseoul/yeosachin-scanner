import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { preflightAcceptedV1Schema } from '@/lib/contracts/analysis-v2';
import { demoResponseHeaders } from '@/lib/services/demo-analysis/demo-analysis';
import { isJsonRequest, isSameOriginMutation } from '@/lib/services/earlybird/contracts';
import { RESULT_PAGE_SIZE_DEFAULT, RESULT_PAGE_SIZE_MAX, decodeResultCursor } from '@/lib/domain/analysis/result-pagination';
import { classifyOperatorAuthError } from '@/lib/services/analysis/score-audit';
import { assertDevUiDeployment, devUiRequestBoundary, DevUiDeploymentError } from './deployment';
import { assertDevUiAdministrator, assertDevUiTester } from './access';
import { DEV_UI_FIXTURE_SCENARIOS, DevUiStoreError, devUiTargetSchema } from './contracts';
import { createDevUiStore } from './store';
import { projectDevUiProgress, projectDevUiResult } from './projection';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const preflightBody = z.object({ targetInstagramId: devUiTargetSchema, fixtureScenario: z.enum(DEV_UI_FIXTURE_SCENARIOS).default('complete') }).strict();
const checkoutBody = z.object({ preflightId: uuid, planId: z.enum(['basic', 'standard']), disclosureAccepted: z.literal(true) }).strict();
const completionBody = z.object({ outcome: z.enum(['success', 'cancel', 'failure']) }).strict();

export function devUiJson(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: { ...demoResponseHeaders(), 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });
}

function failure(status: number, code: string, error: string): NextResponse {
    return devUiJson({ schemaVersion: 1, code, error }, status);
}

/** Existing handlers branch here before production observation or providers. */
export function shouldHandleDevUiRequest(request: Request): boolean {
    return devUiRequestBoundary(request) !== 'production';
}

function storeFailure(error: unknown): NextResponse {
    if (error instanceof DevUiDeploymentError) return failure(403, error.code, '테스트 환경 구성을 확인할 수 없습니다.');
    if (!(error instanceof DevUiStoreError)) return failure(503, 'DEV_UI_UNAVAILABLE', '테스트 요청을 잠시 후 다시 시도해주세요.');
    if (error.code === 'DEV_UI_ACCESS_DENIED') return failure(403, error.code, '등록된 테스트 계정만 이용할 수 있습니다.');
    if (error.code === 'DEV_UI_INVALID_INPUT') return failure(400, error.code, '요청 형식을 확인해주세요.');
    if (error.code === 'DEV_UI_NOT_FOUND') return failure(404, error.code, '테스트 요청을 찾을 수 없습니다.');
    if (error.code === 'DEV_UI_EXPIRED') return failure(410, 'PREFLIGHT_EXPIRED', '사전 점검 요청이 만료되었습니다. 새 사전 점검을 시작해주세요.');
    if (error.code === 'DEV_UI_RUN_EXPIRED') return failure(410, error.code, '테스트 실행의 보존 기간이 지났습니다.');
    if (error.code === 'DEV_UI_RESULT_NOT_READY') return devUiJson({ code: 'RESULT_PENDING', status: 'pending', error: '모의 분석이 진행 중입니다.' }, 404);
    if (error.code === 'DEV_UI_RUN_FAILED') return failure(404, error.code, '선택한 합성 시나리오의 분석이 실패했습니다.');
    if (error.code.endsWith('_CONFLICT') || error.code === 'DEV_UI_SNAPSHOT_MISMATCH') return failure(409, error.code, '이미 처리된 요청입니다. 새 사전 점검을 시작해주세요.');
    return failure(503, error.code, '테스트 요청을 잠시 후 다시 시도해주세요.');
}

/** getUser verifies the Dev Auth session; request values cannot select a user. */
export async function withDevUiSession(
    request: Request,
    operation: (user: User) => Promise<NextResponse>,
    options: { access?: 'tester' | 'admin' | 'authenticated' } = {},
): Promise<NextResponse> {
    try {
        if (devUiRequestBoundary(request) !== 'dev') return failure(403, 'DEV_UI_DEPLOYMENT_REJECTED', '허용되지 않은 테스트 요청입니다.');
        assertDevUiDeployment(request);
        if (request.method !== 'GET') {
            if (!isSameOriginMutation(request)) return failure(403, 'FORBIDDEN_ORIGIN', '허용되지 않은 요청입니다.');
            if (!isJsonRequest(request)) return failure(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 요청이 필요합니다.');
        }
        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error && classifyOperatorAuthError(error) !== 'unauthorized') return failure(503, 'DEV_UI_AUTH_UNAVAILABLE', '인증 서비스를 잠시 후 다시 확인해주세요.');
        if (error || !user || !uuid.safeParse(user.id).success) return failure(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
        if (options.access === 'admin') assertDevUiAdministrator(user.id, request);
        else if (options.access !== 'authenticated') assertDevUiTester(user.id, request);
        return await operation(user);
    } catch (error) {
        return storeFailure(error);
    }
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try { body = await request.json(); } catch { throw new DevUiStoreError('DEV_UI_INVALID_INPUT'); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
    return parsed.data;
}

function parseId(value: string): string {
    const parsed = uuid.safeParse(value);
    if (!parsed.success) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
    return parsed.data;
}

export function handleDevUiPreflightCreate(request: Request): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        const body = await parseBody(request, preflightBody);
        const idempotencyKey = request.headers.get('idempotency-key')?.trim();
        if (!idempotencyKey || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
        const accepted = await createDevUiStore().createOrReplayPreflight({ userId: user.id, ...body, idempotencyKey });
        return devUiJson(preflightAcceptedV1Schema.parse({ schemaVersion: 1, preflightId: accepted.preflightId,
            expiresAt: accepted.expiresAt, status: 'pending', exclusionDecision: 'pending' }), 202);
    });
}

export function handleDevUiPreflightRead(request: Request, preflightId: string): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        const preflight = await createDevUiStore().readPreflight({ userId: user.id, preflightId: parseId(preflightId) });
        if (!preflight) throw new DevUiStoreError('DEV_UI_NOT_FOUND');
        if (preflight.status === 'expired') throw new DevUiStoreError('DEV_UI_EXPIRED');
        if (!preflight.snapshot) throw new DevUiStoreError('DEV_UI_INVALID_ROW');
        return devUiJson(preflight.snapshot);
    });
}

export function handleDevUiCheckoutCreate(request: Request): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        const body = await parseBody(request, checkoutBody);
        return devUiJson(await createDevUiStore().createOrReplayCheckout({ userId: user.id, ...body }));
    });
}

export function handleDevUiResultRead(request: Request, runId: string): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        const url = new URL(request.url);
        const allowed = new Set(['femaleCursor', 'privateCursor', 'pageSize']);
        if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
        const rawSize = url.searchParams.get('pageSize');
        const pageSize = rawSize === null ? RESULT_PAGE_SIZE_DEFAULT : /^\d{1,2}$/.test(rawSize) ? Number(rawSize) : NaN;
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > RESULT_PAGE_SIZE_MAX) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
        const femaleCursor = url.searchParams.get('femaleCursor');
        const privateCursor = url.searchParams.get('privateCursor');
        try {
            if (femaleCursor && decodeResultCursor(femaleCursor).list !== 'public') throw new Error();
            if (privateCursor && decodeResultCursor(privateCursor).list !== 'private') throw new Error();
        } catch { throw new DevUiStoreError('DEV_UI_INVALID_INPUT'); }
        const run = await createDevUiStore().readRun({ userId: user.id, runId: parseId(runId) });
        if (!run) throw new DevUiStoreError('DEV_UI_NOT_FOUND');
        try { return devUiJson(projectDevUiResult(run, { femaleCursor, privateCursor, pageSize })); }
        catch (error) { if (error instanceof DevUiStoreError) throw error; throw new DevUiStoreError('DEV_UI_INVALID_INPUT'); }
    });
}

export function handleDevUiUserMe(request: Request): Promise<NextResponse> {
    return withDevUiSession(request, async user => devUiJson({ user: {
        id: user.id, email: user.email ?? '', provider: user.app_metadata?.provider === 'kakao' ? 'kakao' : 'google',
        analysis_count: 0, is_paid_user: false, is_unlimited: false, created_at: user.created_at, updated_at: user.updated_at ?? user.created_at,
    } }), { access: 'authenticated' });
}

export function handleDevUiCheckoutRead(request: Request, orderId: string): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        const order = await createDevUiStore().readCheckout({ userId: user.id, orderId: parseId(orderId) });
        if (!order) throw new DevUiStoreError('DEV_UI_NOT_FOUND');
        return devUiJson({ simulation: true, order });
    });
}

export function handleDevUiCheckoutComplete(request: Request, orderId: string): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        const body = await parseBody(request, completionBody);
        return devUiJson(await createDevUiStore().completeCheckout({ userId: user.id, orderId: parseId(orderId), ...body }));
    });
}

export function handleDevUiProgressRead(request: Request, runId: string): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        const params = new URL(request.url).searchParams;
        if ([...params.keys()].some(key => !['afterSeq', 'limit'].includes(key) || params.getAll(key).length !== 1)) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
        const readInteger = (name: string, fallback: number, min: number, max: number) => {
            const raw = params.get(name);
            const value = raw === null ? fallback : /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
            if (!Number.isSafeInteger(value) || value < min || value > max) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
            return value;
        };
        const afterSequence = readInteger('afterSeq', 0, 0, Number.MAX_SAFE_INTEGER);
        const eventLimit = readInteger('limit', 100, 1, 200);
        const run = await createDevUiStore().readRun({ userId: user.id, runId: parseId(runId) });
        if (!run) throw new DevUiStoreError('DEV_UI_NOT_FOUND');
        return devUiJson(projectDevUiProgress(run, { afterSequence, eventLimit }));
    });
}

export function handleDevUiOwnerOrders(request: Request): Promise<NextResponse> {
    return withDevUiSession(request, async user => devUiJson({ simulation: true, orders: await createDevUiStore().listOwnerOrders({ userId: user.id }) }));
}

export function handleDevUiAdminOrders(request: Request): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        if (new URL(request.url).search) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
        return devUiJson({ simulation: true, orders: await createDevUiStore().listAdminOrders({ adminUserId: user.id }) });
    }, { access: 'admin' });
}

export function handleDevUiAdminOrder(request: Request, orderId: string): Promise<NextResponse> {
    return withDevUiSession(request, async user => {
        if (new URL(request.url).search) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
        const order = await createDevUiStore().readAdminOrder({ adminUserId: user.id, orderId: parseId(orderId) });
        if (!order) throw new DevUiStoreError('DEV_UI_NOT_FOUND');
        return devUiJson({ simulation: true, order });
    }, { access: 'admin' });
}
