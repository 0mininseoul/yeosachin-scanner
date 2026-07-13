import { z } from 'zod';
import { NextResponse } from 'next/server';
import {
    ANALYSIS_V2_SCHEMA_VERSION,
    planIdSchema,
} from '@/lib/contracts/analysis-v2';
import {
    analysisTestEntitlementsEnabled,
    assertAnalysisTestEntitlementConfiguration,
    verifyAnalysisTestEntitlement,
} from '@/lib/services/analysis/test-entitlement';
import {
    AnalysisV2EntitlementConsumptionError,
    consumeAnalysisV2TestEntitlement,
    hashAnalysisTestEntitlementJti,
    validatePreflightForTestEntitlement,
    type AnalysisV2EntitlementErrorCode,
    type AnalysisV2PreflightRow,
} from '@/lib/services/analysis/test-entitlement-consumption';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { isAnalysisV2StartAvailable } from '@/lib/services/analysis/v2-execution-gate';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const requestBodySchema = z.object({
    planId: planIdSchema,
}).strict();

const PREFLIGHT_COLUMNS = [
    'id',
    'user_id',
    'status',
    'expires_at',
    'target_instagram_id',
    'target_followers_count',
    'target_following_count',
    'access_mode',
    'capacity_required_plan_id',
    'required_plan_id',
    'launch_status_snapshot',
    'plan_cards_snapshot',
    'exclusion_decision',
    'excluded_instagram_id',
    'pricing_version',
    'pricing_snapshot',
    'consumed_request_id',
].join(', ');

const ERROR_STATUS: Readonly<Record<AnalysisV2EntitlementErrorCode, number>> = {
    ANALYSIS_V2_PREFLIGHT_NOT_FOUND: 404,
    ANALYSIS_V2_PREFLIGHT_NOT_READY: 409,
    ANALYSIS_V2_PREFLIGHT_EXPIRED: 410,
    ANALYSIS_V2_EXCLUSION_REQUIRED: 409,
    ANALYSIS_V2_PLAN_NOT_ALLOWED: 409,
    ANALYSIS_V2_ENTITLEMENT_CONFLICT: 409,
    ANALYSIS_ALREADY_IN_PROGRESS: 409,
};

function entitlementError(code: AnalysisV2EntitlementErrorCode) {
    return NextResponse.json(
        { error: '분석 테스트 이용권을 사용할 수 없습니다.', code },
        { status: ERROR_STATUS[code] }
    );
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ preflightId: string }> }
) {
    try {
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.', code: 'AUTHENTICATION_REQUIRED' },
                { status: 401 }
            );
        }
        let entitlementsEnabled = false;
        try {
            entitlementsEnabled = analysisTestEntitlementsEnabled();
            if (entitlementsEnabled) assertAnalysisTestEntitlementConfiguration();
        } catch {
            console.error('Analysis V2 test entitlement configuration is invalid.');
            return NextResponse.json(
                {
                    error: '분석 테스트 이용권 설정을 확인할 수 없습니다.',
                    code: 'TEST_ENTITLEMENTS_UNAVAILABLE',
                },
                { status: 503 }
            );
        }
        if (!entitlementsEnabled) {
            return NextResponse.json(
                {
                    error: '분석 테스트 이용권 기능이 비활성화되어 있습니다.',
                    code: 'TEST_ENTITLEMENTS_DISABLED',
                },
                { status: 503 }
            );
        }
        if (!isAnalysisV2StartAvailable()) {
            return NextResponse.json(
                {
                    error: 'V2 백그라운드 분석 실행기가 아직 활성화되지 않았습니다.',
                    code: 'V2_PIPELINE_UNAVAILABLE',
                },
                { status: 503 }
            );
        }

        const parsedPreflightId = uuidSchema.safeParse((await params).preflightId);
        if (!parsedPreflightId.success) {
            return NextResponse.json(
                { error: '사전 점검 ID가 올바르지 않습니다.', code: 'INVALID_PREFLIGHT_ID' },
                { status: 400 }
            );
        }
        const preflightId = parsedPreflightId.data;

        let rawBody: unknown;
        try {
            rawBody = await request.json();
        } catch {
            return NextResponse.json(
                { error: '요청 형식이 올바르지 않습니다.', code: 'INVALID_REQUEST' },
                { status: 400 }
            );
        }
        const body = requestBodySchema.safeParse(rawBody);
        if (!body.success) {
            return NextResponse.json(
                { error: '요청 형식이 올바르지 않습니다.', code: 'INVALID_REQUEST' },
                { status: 400 }
            );
        }

        const entitlementToken = request.headers.get('x-analysis-test-entitlement');
        if (!entitlementToken) {
            return NextResponse.json(
                { error: '유효한 분석 테스트 이용권이 필요합니다.', code: 'INVALID_ENTITLEMENT' },
                { status: 403 }
            );
        }

        const preflightQuery = await supabaseAdmin
            .from('analysis_preflights')
            .select(PREFLIGHT_COLUMNS)
            .eq('id', preflightId)
            .eq('user_id', user.id)
            .maybeSingle();
        if (preflightQuery.error) {
            throw new Error('ANALYSIS_V2_ENTITLEMENT_ROUTE_ERROR: preflight read failed.');
        }
        if (!preflightQuery.data) {
            return entitlementError('ANALYSIS_V2_PREFLIGHT_NOT_FOUND');
        }

        const row = preflightQuery.data as unknown as AnalysisV2PreflightRow;
        if (row.id !== preflightId || row.user_id !== user.id.toLowerCase()) {
            return entitlementError('ANALYSIS_V2_PREFLIGHT_NOT_FOUND');
        }

        validatePreflightForTestEntitlement(row, body.data.planId);
        const entitlement = verifyAnalysisTestEntitlement(entitlementToken, {
            preflightId,
            userId: user.id,
            planId: body.data.planId,
        });
        if (!entitlement) {
            return NextResponse.json(
                { error: '유효한 분석 테스트 이용권이 필요합니다.', code: 'INVALID_ENTITLEMENT' },
                { status: 403 }
            );
        }

        const consumed = await consumeAnalysisV2TestEntitlement(supabaseAdmin, {
            preflightId,
            userId: user.id,
            selectedPlanId: body.data.planId,
            entitlementJtiHash: hashAnalysisTestEntitlementJti(entitlement.nonce),
        });

        return NextResponse.json({
            schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
            requestId: consumed.requestId,
            status: 'queued',
            backgroundProcessing: false,
        }, { status: consumed.created ? 201 : 200 });
    } catch (error) {
        if (error instanceof AnalysisV2EntitlementConsumptionError) {
            return entitlementError(error.code);
        }
        // Deliberately omit request headers and error details: they may contain credentials.
        console.error('Analysis V2 test entitlement consumption failed.');
        return NextResponse.json(
            { error: '분석 요청 생성에 실패했습니다.', code: 'ANALYSIS_START_FAILED' },
            { status: 500 }
        );
    }
}
