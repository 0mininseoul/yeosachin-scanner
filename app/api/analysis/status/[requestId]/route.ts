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

const STATUS_COLUMNS = 'id, user_id, status, current_step, progress, progress_step, error_message, background_processing, created_at, completed_at, idempotency_key';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
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

        if (
            ['pending', 'processing'].includes(analysisRequest.status)
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
            status: analysisRequest.status,
            progress: analysisRequest.progress,
            progressStep: analysisRequest.progress_step,
            errorMessage: analysisRequest.error_message,
            backgroundProcessing: analysisRequest.background_processing === true,
            createdAt: analysisRequest.created_at,
            completedAt: analysisRequest.completed_at,
            // Keep the response field stable until a telemetry-based estimate is available.
            estimatedCompletionTime: null,
        });
    } catch (error) {
        console.error('Status check error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
