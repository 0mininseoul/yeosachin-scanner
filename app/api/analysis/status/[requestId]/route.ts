import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    failAnalysisRequest,
    isAnalysisRequestStale,
} from '@/lib/services/analysis/failure';
import { abortRunningAnalysisProviderRuns } from '@/lib/services/analysis/provider-run';
import { expireStaleAnalysisBeforeStart } from '@/lib/services/analysis/start-cleanup';
import {
    ANALYSIS_STEP_LEASE_SECONDS,
    acquireAnalysisRequestLease,
    releaseAnalysisRequestLease,
} from '@/lib/services/analysis/request-lease';
import { NextResponse } from 'next/server';
import { demoResponseHeaders, isDemoOperator } from '@/lib/services/demo-analysis/demo-analysis';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
} from '@/lib/services/identity/account-principal-store';

const STATUS_COLUMNS = 'id, user_id, pipeline_version, status, current_step, progress, progress_step, error_message, background_processing, created_at, completed_at, idempotency_key';

function isV1Pipeline(value: unknown): boolean {
    return value === null || value === 'v1';
}

const PRIVATE_NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
} as const;

export async function GET(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
    let demoRecognized = false;
    try {
        const { requestId } = await params;
        const supabase = await createClient();

        // 1. 인증 체크
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.' },
                { status: 401 }
            );
        }

        try {
            await requireActiveAccountClassification(user.id);
        } catch (error) {
            if (error instanceof AccountPrincipalAdmissionError) {
                return NextResponse.json(
                    { error: '이 계정은 현재 사용할 수 없습니다.' },
                    { status: 403 },
                );
            }
            throw error;
        }

        const demo = await demoAnalysisStore.findForOwner(requestId, user.id);
        if (demo) {
            demoRecognized = true;
            if (!isDemoOperator(user.id)) return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404, headers: demoResponseHeaders() }
            );
            return NextResponse.json({
                error: 'V2 분석은 전용 진행 경로를 사용합니다.', code: 'V2_ROUTE_REQUIRED', pipelineVersion: 'v2',
                progressUrl: `/api/analysis/progress/${encodeURIComponent(demo.id)}`,
            }, { status: 409, headers: demoResponseHeaders() });
        }

        // Re-check ownership on the admin query instead of relying on a client-provided ID.
        const initialStatus = await supabaseAdmin
            .from('analysis_requests')
            .select(STATUS_COLUMNS)
            .eq('id', requestId)
            .eq('user_id', user.id)
            .maybeSingle();

        if (initialStatus.error || !initialStatus.data) {
            return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404 }
            );
        }
        let analysisRequest = initialStatus.data;

        if (!isV1Pipeline(analysisRequest.pipeline_version)) {
            return NextResponse.json({
                error: 'V2 분석은 전용 진행 경로를 사용합니다.',
                code: 'V2_ROUTE_REQUIRED',
                pipelineVersion: 'v2',
                progressUrl: `/api/analysis/progress/${encodeURIComponent(analysisRequest.id)}`,
            }, {
                status: 409,
                headers: PRIVATE_NO_STORE_HEADERS,
            });
        }

        if (
            isV1Pipeline(analysisRequest.pipeline_version)
            && ['pending', 'processing'].includes(analysisRequest.status)
            && isAnalysisRequestStale(analysisRequest.created_at)
        ) {
            await expireStaleAnalysisBeforeStart(undefined, {
                loadActiveRequest: async () => analysisRequest,
                acquireCleanupLease: async (candidate) => acquireAnalysisRequestLease(
                    supabaseAdmin,
                    {
                        requestId: candidate.id,
                        userId: user.id,
                        expectedStep: candidate.currentStep,
                        leaseSeconds: ANALYSIS_STEP_LEASE_SECONDS,
                    }
                ),
                releaseCleanupLease: async (lease) => {
                    await releaseAnalysisRequestLease(supabaseAdmin, lease);
                },
                abortProviderRuns: async (candidate) => {
                    await abortRunningAnalysisProviderRuns(supabaseAdmin, {
                        requestId: candidate.id,
                        userId: user.id,
                    });
                },
                failRequest: async (candidate) => failAnalysisRequest(supabaseAdmin, {
                    requestId: candidate.id,
                    userId: user.id,
                    expectedStep: candidate.currentStep,
                    errorMessage: '분석 처리 시간이 초과되었습니다. 새 분석을 시작해주세요.',
                }),
            });

            const refreshed = await supabaseAdmin
                .from('analysis_requests')
                .select(STATUS_COLUMNS)
                .eq('id', requestId)
                .eq('user_id', user.id)
                .maybeSingle();
            if (refreshed.error || !refreshed.data) {
                throw new Error('Analysis status refresh failed.');
            }
            analysisRequest = refreshed.data;
        }

        return NextResponse.json({
            requestId: analysisRequest.id,
            pipelineVersion: 'v1',
            status: analysisRequest.status,
            progress: analysisRequest.progress,
            progressStep: analysisRequest.progress_step,
            errorMessage: analysisRequest.error_message,
            backgroundProcessing: analysisRequest.background_processing === true,
            createdAt: analysisRequest.created_at,
            completedAt: analysisRequest.completed_at,
            // Keep the response field stable until a telemetry-based estimate is available.
            estimatedCompletionTime: null,
        }, { headers: PRIVATE_NO_STORE_HEADERS });
    } catch (error) {
        console.error('Status check error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            demoRecognized
                ? { status: 500, headers: demoResponseHeaders() }
                : { status: 500 }
        );
    }
}
