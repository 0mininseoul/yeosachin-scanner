import { after, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    isJsonRequest,
    isSameOriginMutation,
    normalizeResultFeedbackBody,
    resultFeedbackRequestSchema,
} from '@/lib/services/feedback/contracts';
import {
    insertResultFeedback,
    ResultFeedbackPersistenceError,
} from '@/lib/services/feedback/store';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
} from '@/lib/services/identity/account-principal-store';
import {
    flushOperationalLogs,
    operationalLogger,
    type OperationalEvent,
} from '@/lib/observability/server';

const PRIVATE_NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
} as const;

function errorResponse(status: number, code: string, error: string): NextResponse {
    return NextResponse.json({ code, error }, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

function emitFeedbackOperationalEvent(event: OperationalEvent): void {
    try {
        operationalLogger.emit(event);
    } catch {
        // Observability must never change the feedback outcome.
    }
}

function scheduleFeedbackLogFlush(): void {
    try {
        after(() => flushOperationalLogs());
    } catch {
        void flushOperationalLogs();
    }
}

// 결과 소유자가 "결과가 정확하지 않나요?"로 남긴 자유 서술을 수집한다.
// 자기 판독에 대해서만 남길 수 있도록 소유권을 서버에서 재확인한다.
export async function POST(request: Request): Promise<NextResponse> {
    if (!isSameOriginMutation(request)) {
        return errorResponse(403, 'FORBIDDEN_ORIGIN', '허용되지 않은 요청입니다.');
    }
    if (!isJsonRequest(request)) {
        return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 요청이 필요합니다.');
    }

    let payload: unknown;
    try {
        payload = await request.json();
    } catch {
        return errorResponse(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }

    const parsed = resultFeedbackRequestSchema.safeParse(payload);
    if (!parsed.success) {
        return errorResponse(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }
    const body = normalizeResultFeedbackBody(parsed.data.body);
    if (!body) {
        return errorResponse(400, 'INVALID_REQUEST', '내용을 입력해 주세요.');
    }

    try {
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return errorResponse(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
        }

        try {
            await requireActiveAccountClassification(user.id);
        } catch (error) {
            if (error instanceof AccountPrincipalAdmissionError) {
                return errorResponse(403, error.code, '이 계정은 현재 사용할 수 없습니다.');
            }
            throw error;
        }

        // Never trust a client-supplied request id: confirm this caller owns it.
        const owned = await supabaseAdmin
            .from('analysis_requests')
            .select('id')
            .eq('id', parsed.data.requestId)
            .eq('user_id', user.id)
            .maybeSingle();
        if (owned.error || !owned.data) {
            return errorResponse(404, 'NOT_FOUND', '판독 기록을 찾을 수 없습니다.');
        }

        try {
            await insertResultFeedback({
                requestId: parsed.data.requestId,
                userId: user.id,
                body,
                userAgent: request.headers.get('user-agent')?.slice(0, 500) || undefined,
            });
        } catch (error) {
            emitFeedbackOperationalEvent({
                event: 'result_feedback.persistence_failed',
                severity: 'error',
                fields: {
                    request_id: parsed.data.requestId,
                    error_code: error instanceof ResultFeedbackPersistenceError
                        ? error.code
                        : 'INTERNAL_ERROR',
                },
            });
            scheduleFeedbackLogFlush();
            throw error;
        }

        emitFeedbackOperationalEvent({
            event: 'result_feedback.persisted',
            severity: 'info',
            fields: { request_id: parsed.data.requestId },
        });
        scheduleFeedbackLogFlush();

        return NextResponse.json({ ok: true }, { status: 201, headers: PRIVATE_NO_STORE_HEADERS });
    } catch {
        return errorResponse(500, 'PERSISTENCE_FAILED', '의견을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
}
