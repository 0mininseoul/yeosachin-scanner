import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    ANALYSIS_V2_SCHEMA_VERSION,
    preflightRequestV1Schema,
} from '@/lib/contracts/analysis-v2';
import {
    acceptedPreflightDto,
    BetaPreflightAccessUnavailableError,
    type PreflightAuthProvider,
    preflightStore,
} from '@/lib/services/analysis/preflight';
import {
    enqueueBetaPreflightPrepareTask,
    getPreflightTasksConfig,
} from '@/lib/services/analysis/preflight-tasks';
import {
    BETA_TEST_ACCESS_UNAVAILABLE,
    betaTestFreePoolEnabled,
    ensureBetaTestAccess,
} from '@/lib/services/analysis/betatest-access';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

function response(status: number, code: string, error: string) {
    return NextResponse.json({ schemaVersion: ANALYSIS_V2_SCHEMA_VERSION, code, error }, { status });
}

function provider(value: unknown): PreflightAuthProvider | null {
    return value === 'google' || value === 'kakao' ? value : null;
}

/** Dedicated beta creation path. Ordinary preflight input is always standard. */
export async function POST(request: Request): Promise<NextResponse> {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return response(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    if (!betaTestFreePoolEnabled() || !await ensureBetaTestAccess(supabaseAdmin, user.id)) {
        return response(403, BETA_TEST_ACCESS_UNAVAILABLE, '베타 분석을 사용할 수 없습니다.');
    }
    let body: unknown;
    try { body = await request.json(); } catch {
        return response(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }
    const parsed = preflightRequestV1Schema.safeParse(body);
    const idempotencyKey = request.headers.get('idempotency-key')?.trim();
    const authProvider = provider(user.app_metadata?.provider);
    const email = user.email?.trim();
    if (!parsed.success || !idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
        || !authProvider || !email || email.length > 320) {
        return response(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }
    let config;
    try { config = getPreflightTasksConfig(); } catch { config = null; }
    if (!config) return response(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
    try {
        // A revoked grant cannot enqueue a mutation after creation either.
        const created = await preflightStore.createOrReplayBeta({
            userId: user.id,
            email,
            authProvider,
            targetInstagramId: parsed.data.targetInstagramId,
            idempotencyKey,
        });
        if (!betaTestFreePoolEnabled() || !await ensureBetaTestAccess(supabaseAdmin, user.id)) {
            await preflightStore.blockBetaPrepareCapacity({
                preflightId: created.preflightId,
                userId: user.id,
                prepareGeneration: created.prepareGeneration,
                prepareToken: created.prepareToken,
                claimToken: null,
            });
            return response(403, BETA_TEST_ACCESS_UNAVAILABLE, '베타 분석을 사용할 수 없습니다.');
        }
        if (created.shouldEnqueue) {
            await enqueueBetaPreflightPrepareTask(
                created.preflightId,
                user.id,
                created.prepareGeneration,
                created.prepareToken,
                { config }
            );
            await preflightStore.markBetaPrepareDispatched({
                preflightId: created.preflightId,
                userId: user.id,
                prepareGeneration: created.prepareGeneration,
                prepareToken: created.prepareToken,
            });
        }
        return NextResponse.json(acceptedPreflightDto(created), { status: created.created ? 202 : 200 });
    } catch (error) {
        if (error instanceof BetaPreflightAccessUnavailableError) {
            return response(
                403,
                BETA_TEST_ACCESS_UNAVAILABLE,
                '베타 분석을 사용할 수 없습니다.'
            );
        }
        return response(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업을 시작할 수 없습니다.');
    }
}
