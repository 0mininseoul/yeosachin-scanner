import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import { parseScraperProviderSelection } from '@/lib/services/instagram/config';
import { hasValidScraperAdminAuthorization } from '@/lib/services/instagram/admin-selection';
import {
    AnalysisAlreadyInProgressError,
    AnalysisIdempotencyConflictError,
    AnalysisLimitExceededError,
    consumeQuotaAndCreateAnalysisRequest,
} from '@/lib/services/analysis/start-request';
import { isInstagramUsername } from '@/lib/services/instagram/username';
import {
    analysisTaskStateFromRow,
    getAnalysisTasksConfig,
    startAnalysisInBackground,
} from '@/lib/services/analysis/background-tasks';
import { expireStaleAnalysisBeforeStart } from '@/lib/services/analysis/start-cleanup';
import { abortRunningAnalysisProviderRuns } from '@/lib/services/analysis/provider-run';
import { failAnalysisRequest } from '@/lib/services/analysis/failure';
import {
    ANALYSIS_STEP_LEASE_SECONDS,
    acquireAnalysisRequestLease,
    releaseAnalysisRequestLease,
} from '@/lib/services/analysis/request-lease';

// 무료 분석 횟수 제한
const FREE_ANALYSIS_LIMIT = 1;

async function tryStartBackgroundProcessing(
    requestId: string,
    userId: string
): Promise<boolean> {
    try {
        const tasksConfig = getAnalysisTasksConfig();
        if (!tasksConfig) return false;

        const { data: analysisRequest, error } = await supabaseAdmin
            .from('analysis_requests')
            .select('status, current_step, progress, step_data, background_processing')
            .eq('id', requestId)
            .eq('user_id', userId)
            .single();

        if (error || !analysisRequest) {
            throw new Error('ANALYSIS_TASKS_STATE_ERROR: request state unavailable.');
        }
        if (analysisRequest.status === 'completed' || analysisRequest.status === 'failed') {
            return analysisRequest.background_processing === true;
        }

        const state = analysisTaskStateFromRow(analysisRequest);
        return await startAnalysisInBackground(requestId, state, async () => {
            const { data: activated, error: activationError } = await supabaseAdmin
                .from('analysis_requests')
                .update({ background_processing: true })
                .eq('id', requestId)
                .eq('user_id', userId)
                .select('id')
                .single();

            if (activationError || !activated) {
                throw new Error('ANALYSIS_TASKS_STATE_ERROR: background activation failed.');
            }
        }, { config: tasksConfig });
    } catch {
        // Queueing is an optimization. The progress page retains the authenticated
        // browser-driven pipeline when configuration, queueing, or activation is unavailable.
        console.error('Analysis background startup unavailable; using browser fallback.');
        return false;
    }
}

export async function POST(request: Request) {
    try {
        const supabase = await createClient();

        // 1. 인증 체크
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.' },
                { status: 401 }
            );
        }

        // 2. 요청 바디 파싱
        const body: unknown = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
        }
        const input = body as Record<string, unknown>;
        const idempotencyKey = request.headers.get('idempotency-key')?.trim();
        if (
            !idempotencyKey ||
            idempotencyKey.length < 16 ||
            idempotencyKey.length > 128 ||
            !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
        ) {
            return NextResponse.json(
                { error: 'A valid Idempotency-Key header is required.' },
                { status: 400 }
            );
        }
        const { targetInstagramId, targetGender } = input;
        const hasScraperOptions = Object.prototype.hasOwnProperty.call(input, 'scraperOptions');

        if (
            hasScraperOptions &&
            !hasValidScraperAdminAuthorization(request.headers.get('authorization'))
        ) {
            return NextResponse.json(
                { error: '스크래퍼 프로바이더 설정을 변경할 권한이 없습니다.' },
                { status: 403 }
            );
        }

        // 3. 입력값 검증
        if (typeof targetInstagramId !== 'string' || typeof targetGender !== 'string') {
            return NextResponse.json(
                { error: '인스타그램 아이디와 성별을 입력해주세요.' },
                { status: 400 }
            );
        }

        if (!['male', 'female'].includes(targetGender)) {
            return NextResponse.json(
                { error: '성별은 male 또는 female만 가능합니다.' },
                { status: 400 }
            );
        }

        let scraperOptions;
        try {
            scraperOptions = parseScraperProviderSelection(input.scraperOptions);
        } catch (error) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : '스크래퍼 설정이 올바르지 않습니다.' },
                { status: 400 }
            );
        }

        // 인스타그램 ID 형식 검증 (@ 제거, 영문/숫자/밑줄/점만 허용)
        const cleanedId = targetInstagramId.replace(/^@/, '').toLowerCase();
        if (!isInstagramUsername(cleanedId)) {
            return NextResponse.json(
                { error: '올바른 인스타그램 아이디를 입력해주세요.' },
                { status: 400 }
            );
        }

        if (!user.email) {
            return NextResponse.json({ error: '인증 이메일을 확인할 수 없습니다.' }, { status: 400 });
        }

        await expireStaleAnalysisBeforeStart(idempotencyKey, {
            loadActiveRequest: async () => {
                const active = await supabaseAdmin
                    .from('analysis_requests')
                    .select('id, status, current_step, created_at, idempotency_key')
                    .eq('user_id', user.id)
                    .in('status', ['pending', 'processing'])
                    .maybeSingle();
                if (active.error) {
                    throw new Error(
                        'ANALYSIS_PERSISTENCE_ERROR: active analysis cleanup read failed.'
                    );
                }
                return active.data;
            },
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
                compactStepData: {},
            }),
        });

        let analysisRequest;
        try {
            analysisRequest = await consumeQuotaAndCreateAnalysisRequest(supabaseAdmin, {
                userId: user.id,
                email: user.email,
                authProvider: user.app_metadata.provider === 'kakao' ? 'kakao' : 'google',
                targetInstagramId: cleanedId,
                targetGender: targetGender as 'male' | 'female',
                scraperOptions: { ...scraperOptions },
                idempotencyKey,
                freeAnalysisLimit: FREE_ANALYSIS_LIMIT,
            });
        } catch (error) {
            if (error instanceof AnalysisIdempotencyConflictError) {
                return NextResponse.json(
                    {
                        error: 'Idempotency-Key was already used for a different analysis request.',
                        code: 'IDEMPOTENCY_CONFLICT',
                    },
                    { status: 409 }
                );
            }
            if (error instanceof AnalysisLimitExceededError) {
                return NextResponse.json(
                    { error: '무료 분석 횟수를 모두 사용했습니다.', code: 'LIMIT_EXCEEDED' },
                    { status: 403 }
                );
            }
            if (error instanceof AnalysisAlreadyInProgressError) {
                return NextResponse.json(
                    {
                        error: '이미 진행 중인 분석이 있습니다.',
                        code: 'ANALYSIS_ALREADY_IN_PROGRESS',
                    },
                    { status: 409 }
                );
            }
            const message = error instanceof Error ? error.message : 'unknown';
            console.error(`Analysis request transaction error: ${message}`);
            return NextResponse.json(
                { error: '분석 요청 생성에 실패했습니다.' },
                { status: 500 }
            );
        }

        const backgroundProcessing = await tryStartBackgroundProcessing(
            analysisRequest.requestId,
            user.id
        );

        return NextResponse.json(
            {
                success: true,
                requestId: analysisRequest.requestId,
                backgroundProcessing,
                message: '분석이 시작되었습니다.',
            },
            { status: analysisRequest.created ? 201 : 200 }
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        console.error(`Analysis start error: ${message}`);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
