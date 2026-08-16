import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import { generateShareToken } from '@/lib/services/share/generate-token';
import { appOriginForRequest } from '@/lib/constants/app-url';
import { demoResponseHeaders, isDemoOperator } from '@/lib/services/demo-analysis/demo-analysis';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
} from '@/lib/services/identity/account-principal-store';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const SHARE_REQUEST_SELECT = 'id, user_id, pipeline_version, status, share_token, share_enabled';
const LEGACY_PIPELINE_FILTER = 'pipeline_version.eq.v1,pipeline_version.is.null';
const V2_PIPELINE_FILTER = 'pipeline_version.eq.v2';

interface ShareRequestRecord {
    id: string;
    user_id: string;
    pipeline_version: string | null;
    status: string;
    share_token: string | null;
    share_enabled: boolean | null;
}

function isLegacySharePipeline(pipelineVersion: unknown): pipelineVersion is 'v1' | null {
    return pipelineVersion === null || pipelineVersion === 'v1';
}

function isSupportedSharePipeline(
    pipelineVersion: unknown
): pipelineVersion is 'v1' | 'v2' | null {
    return isLegacySharePipeline(pipelineVersion) || pipelineVersion === 'v2';
}

function pipelineFilter(pipelineVersion: 'v1' | 'v2' | null): string {
    return pipelineVersion === 'v2'
        ? V2_PIPELINE_FILTER
        : LEGACY_PIPELINE_FILTER;
}

function isStoredShareToken(value: unknown): value is string {
    return typeof value === 'string' && SHARE_TOKEN_PATTERN.test(value);
}

function unsupportedPipelineResponse(pipelineVersion: unknown) {
    return NextResponse.json(
        {
            code: pipelineVersion === 'v2'
                ? 'V2_SHARE_UNSUPPORTED'
                : 'SHARE_PIPELINE_UNSUPPORTED',
            error: '이 판독 결과는 아직 공유할 수 없습니다.',
        },
        { status: 409 }
    );
}

async function readEnabledWinner(
    requestId: string,
    userId: string,
    pipelineVersion: 'v1' | 'v2' | null
) {
    return supabaseAdmin
        .from('analysis_requests')
        .select(SHARE_REQUEST_SELECT)
        .eq('id', requestId)
        .eq('user_id', userId)
        .eq('status', 'completed')
        .eq('share_enabled', true)
        .or(pipelineFilter(pipelineVersion))
        .maybeSingle();
}

async function compareAndSetShareEnabled(
    requestId: string,
    userId: string,
    expectedToken: string | null,
    pipelineVersion: 'v1' | 'v2' | null,
) {
    const candidateToken = expectedToken ?? generateShareToken();
    const baseMutation = supabaseAdmin
        .from('analysis_requests')
        .update({
            share_token: candidateToken,
            share_enabled: true,
        })
        .eq('id', requestId)
        .eq('user_id', userId)
        .eq('status', 'completed')
        .or(pipelineFilter(pipelineVersion));
    const conditionalMutation = expectedToken === null
        ? baseMutation.is('share_token', null)
        : baseMutation
            .eq('share_token', expectedToken)
            .or('share_enabled.eq.false,share_enabled.is.null');

    const mutation = await conditionalMutation
        .select(SHARE_REQUEST_SELECT)
        .maybeSingle();
    if (mutation.error) return { data: null, error: mutation.error };
    if (
        mutation.data
        && mutation.data.pipeline_version === pipelineVersion
        && mutation.data.status === 'completed'
        && mutation.data.share_enabled === true
        && isStoredShareToken(mutation.data.share_token)
    ) {
        return { data: mutation.data as ShareRequestRecord, error: null };
    }

    // A concurrent request may have won the compare-and-set. Always return
    // the committed winner rather than the losing request's candidate token.
    return readEnabledWinner(requestId, userId, pipelineVersion);
}

async function readDisabledWinner(
    requestId: string,
    userId: string,
    pipelineVersion: 'v1' | 'v2' | null
) {
    return supabaseAdmin
        .from('analysis_requests')
        .select(SHARE_REQUEST_SELECT)
        .eq('id', requestId)
        .eq('user_id', userId)
        .eq('status', 'completed')
        .eq('share_enabled', false)
        .is('share_token', null)
        .or(pipelineFilter(pipelineVersion))
        .maybeSingle();
}

async function compareAndSetShareDisabled(
    requestId: string,
    userId: string,
    expectedToken: string | null,
    expectedEnabled: boolean | null,
    pipelineVersion: 'v1' | 'v2' | null
) {
    const baseMutation = supabaseAdmin
        .from('analysis_requests')
        .update({
            share_enabled: false,
            share_token: null,
        })
        .eq('id', requestId)
        .eq('user_id', userId)
        .eq('status', 'completed')
        .or(pipelineFilter(pipelineVersion));
    const enabledMutation = expectedEnabled === null
        ? baseMutation.is('share_enabled', null)
        : baseMutation.eq('share_enabled', expectedEnabled);
    const tokenMutation = expectedToken === null
        ? enabledMutation.is('share_token', null)
        : enabledMutation.eq('share_token', expectedToken);
    const mutation = await tokenMutation
        .select(SHARE_REQUEST_SELECT)
        .maybeSingle();

    if (mutation.error) return { data: null, error: mutation.error };
    if (
        mutation.data
        && mutation.data.pipeline_version === pipelineVersion
        && mutation.data.status === 'completed'
        && mutation.data.share_enabled === false
        && mutation.data.share_token === null
    ) {
        return { data: mutation.data as ShareRequestRecord, error: null };
    }

    // Another revoke may have committed first. Treat the already-disabled
    // owner row as the winner, while keeping the old public token unusable.
    return readDisabledWinner(requestId, userId, pipelineVersion);
}

export async function POST(request: Request) {
    let demoRecognized = false;
    try {
        const { requestId } = await request.json();

        if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) {
            return NextResponse.json(
                { error: 'requestId가 필요합니다.' },
                { status: 400 }
            );
        }

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
                    { code: error.code, error: '이 계정은 현재 사용할 수 없습니다.' },
                    { status: 403 },
                );
            }
            throw error;
        }

        const demo = await demoAnalysisStore.findForOwner(requestId, user.id);
        if (demo) {
            demoRecognized = true;
            return demo.user_id === user.id && isDemoOperator(user.id)
                ? NextResponse.json(
                    { error: '이 판독 결과는 공유할 수 없습니다.' },
                    { status: 409, headers: demoResponseHeaders() }
                )
                : NextResponse.json(
                    { error: '분석 요청을 찾을 수 없습니다.' },
                    { status: 404, headers: demoResponseHeaders() }
                );
        }

        // 2. 분석 요청 조회 및 소유자 확인
        const { data: analysisRequest, error: requestError } = await supabaseAdmin
            .from('analysis_requests')
            .select(SHARE_REQUEST_SELECT)
            .eq('id', requestId)
            .eq('user_id', user.id)
            .single();

        if (requestError || !analysisRequest) {
            return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404 }
            );
        }

        // 3. 소유자 확인
        if (analysisRequest.user_id !== user.id) {
            return NextResponse.json(
                { error: '권한이 없습니다.' },
                { status: 403 }
            );
        }

        if (!isSupportedSharePipeline(analysisRequest.pipeline_version)) {
            return unsupportedPipelineResponse(analysisRequest.pipeline_version);
        }

        // 4. 분석 완료 상태 확인
        if (analysisRequest.status !== 'completed') {
            return NextResponse.json(
                { error: '분석이 완료된 후에 공유할 수 있습니다.' },
                { status: 400 }
            );
        }

        if (!await isAnalysisResultAuthoritativelyPublished(analysisRequest.id)) {
            return NextResponse.json(
                {
                    error: '분석 결과가 아직 공개 준비 중입니다.',
                    code: 'RESULT_PENDING',
                    status: 'pending',
                },
                { status: 409 }
            );
        }

        // 5. 활성 토큰은 그대로 사용하고, 생성/재활성화는 완성 상태와
        // legacy 파이프라인 및 이전 토큰 상태를 모두 묶은 CAS로 수행한다.
        let shareRecord = analysisRequest as ShareRequestRecord;
        if (!analysisRequest.share_enabled || !isStoredShareToken(analysisRequest.share_token)) {
            const expectedToken = isStoredShareToken(analysisRequest.share_token)
                ? analysisRequest.share_token
                : null;
            const mutation = await compareAndSetShareEnabled(
                requestId,
                user.id,
                expectedToken,
                analysisRequest.pipeline_version
            );
            if (mutation.error) {
                console.error('Share compare-and-set failed');
                return NextResponse.json(
                    { error: '공유 링크 생성에 실패했습니다.' },
                    { status: 500 }
                );
            }
            if (!mutation.data || !isStoredShareToken(mutation.data.share_token)) {
                return NextResponse.json(
                    {
                        code: 'SHARE_STATE_CHANGED',
                        error: '공유 상태가 변경되었습니다. 다시 시도해 주세요.',
                    },
                    { status: 409 }
                );
            }
            shareRecord = mutation.data as ShareRequestRecord;
        }
        const shareToken = shareRecord.share_token;
        if (!isStoredShareToken(shareToken)) {
            return NextResponse.json(
                {
                    code: 'SHARE_STATE_CHANGED',
                    error: '공유 상태가 변경되었습니다. 다시 시도해 주세요.',
                },
                { status: 409 }
            );
        }

        // 6. 공유 URL 생성
        const shareUrl = new URL(
            `/share/${shareToken}`,
            appOriginForRequest(request.url)
        ).toString();
        return NextResponse.json({
            success: true,
            shareToken,
            shareUrl,
            ...(analysisRequest.pipeline_version === 'v2'
                ? {
                    ogImageUrl: new URL(
                        `/api/share/${shareToken}/opengraph-image`,
                        appOriginForRequest(request.url)
                    ).toString(),
                }
                : {}),
        }, {
            headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                Vary: 'Cookie',
            },
        });
    } catch {
        console.error('Share enable error');
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            demoRecognized
                ? { status: 500, headers: demoResponseHeaders() }
                : { status: 500 }
        );
    }
}

export async function DELETE(request: Request) {
    let demoRecognized = false;
    try {
        const { requestId } = await request.json();
        if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) {
            return NextResponse.json(
                { error: 'requestId가 필요합니다.' },
                { status: 400 }
            );
        }

        const supabase = await createClient();
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
                    { code: error.code, error: '이 계정은 현재 사용할 수 없습니다.' },
                    { status: 403 },
                );
            }
            throw error;
        }

        const demo = await demoAnalysisStore.findForOwner(requestId, user.id);
        if (demo) {
            demoRecognized = true;
            return demo.user_id === user.id && isDemoOperator(user.id)
                ? NextResponse.json(
                    { error: '이 판독 결과는 공유할 수 없습니다.' },
                    { status: 409, headers: demoResponseHeaders() }
                )
                : NextResponse.json(
                    { error: '분석 요청을 찾을 수 없습니다.' },
                    { status: 404, headers: demoResponseHeaders() }
                );
        }

        const { data: analysisRequest, error: requestError } = await supabaseAdmin
            .from('analysis_requests')
            .select(SHARE_REQUEST_SELECT)
            .eq('id', requestId)
            .eq('user_id', user.id)
            .single();
        if (requestError || !analysisRequest) {
            return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404 }
            );
        }
        if (analysisRequest.user_id !== user.id) {
            return NextResponse.json(
                { error: '권한이 없습니다.' },
                { status: 403 }
            );
        }
        if (!isSupportedSharePipeline(analysisRequest.pipeline_version)) {
            return unsupportedPipelineResponse(analysisRequest.pipeline_version);
        }
        if (analysisRequest.status !== 'completed') {
            return NextResponse.json(
                { error: '분석이 완료된 후에 공유를 해제할 수 있습니다.' },
                { status: 400 }
            );
        }
        if (
            analysisRequest.share_token !== null
            && typeof analysisRequest.share_token !== 'string'
        ) {
            return NextResponse.json(
                {
                    code: 'SHARE_STATE_CHANGED',
                    error: '공유 상태가 변경되었습니다. 다시 시도해 주세요.',
                },
                { status: 409 }
            );
        }

        const expectedEnabled = analysisRequest.share_enabled === true
            ? true
            : analysisRequest.share_enabled === false
                ? false
                : null;
        const mutation = await compareAndSetShareDisabled(
            requestId,
            user.id,
            analysisRequest.share_token,
            expectedEnabled,
            analysisRequest.pipeline_version
        );
        if (mutation.error) {
            console.error('Share revoke compare-and-set failed');
            return NextResponse.json(
                { error: '공유 해제에 실패했습니다.' },
                { status: 500 }
            );
        }
        if (!mutation.data) {
            return NextResponse.json(
                {
                    code: 'SHARE_STATE_CHANGED',
                    error: '공유 상태가 변경되었습니다. 다시 시도해 주세요.',
                },
                { status: 409 }
            );
        }

        return NextResponse.json(
            { success: true },
            {
                headers: {
                    'Cache-Control': 'private, no-store, max-age=0',
                    Vary: 'Cookie',
                },
            }
        );
    } catch {
        console.error('Share revoke error');
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            demoRecognized
                ? { status: 500, headers: demoResponseHeaders() }
                : { status: 500 }
        );
    }
}
