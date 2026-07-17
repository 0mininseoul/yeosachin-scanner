import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
    earlybirdWaitlistRequestSchema,
    isJsonRequest,
    isSameOriginMutation,
} from '@/lib/services/earlybird/contracts';
import { joinEarlybirdWaitlist } from '@/lib/services/earlybird/checkout';
import { EarlybirdPersistenceError } from '@/lib/services/earlybird/store';

function errorResponse(status: number, code: string, error: string): NextResponse {
    return NextResponse.json({ code, error }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
    if (!isSameOriginMutation(request)) {
        return errorResponse(403, 'FORBIDDEN_ORIGIN', '허용되지 않은 요청입니다.');
    }
    if (!isJsonRequest(request)) {
        return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 요청이 필요합니다.');
    }

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return errorResponse(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return errorResponse(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }
    const parsed = earlybirdWaitlistRequestSchema.safeParse(body);
    if (!parsed.success) {
        return errorResponse(400, 'INVALID_REQUEST', 'Plus 플랜 대기 신청만 가능합니다.');
    }

    try {
        const result = await joinEarlybirdWaitlist({
            userId: user.id,
            preflightId: parsed.data.preflightId,
        });
        return NextResponse.json({
            waitlistId: result.waitlistId,
            status: 'waitlisted',
        }, { status: result.created ? 201 : 200 });
    } catch (error) {
        if (error instanceof EarlybirdPersistenceError
            && error.code === 'EARLYBIRD_WAITLIST_NOT_ELIGIBLE') {
            return errorResponse(409, error.code, 'Plus 대기 신청 대상이 아닙니다.');
        }
        return errorResponse(503, 'EARLYBIRD_UNAVAILABLE', '대기 신청을 잠시 후 다시 시도해주세요.');
    }
}
