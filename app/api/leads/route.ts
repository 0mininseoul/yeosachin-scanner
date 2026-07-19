import { NextResponse } from 'next/server';
import {
    isJsonRequest,
    isSameOriginMutation,
    landingLeadRequestSchema,
    normalizeLeadInstagramId,
} from '@/lib/services/leads/contracts';
import { insertLandingLead } from '@/lib/services/leads/store';

function errorResponse(status: number, code: string, error: string): NextResponse {
    return NextResponse.json({ code, error }, { status });
}

// 로그아웃 유저가 랜딩에서 로그인 벽에 도달하는 시점에 호출되는 익명 리드 수집 엔드포인트.
// 인증을 요구하지 않으며, 같은 오리진 + JSON + zod 검증으로만 게이트한다.
export async function POST(request: Request): Promise<NextResponse> {
    if (!isSameOriginMutation(request)) {
        return errorResponse(403, 'FORBIDDEN_ORIGIN', '허용되지 않은 요청입니다.');
    }
    if (!isJsonRequest(request)) {
        return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 요청이 필요합니다.');
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return errorResponse(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }
    const parsed = landingLeadRequestSchema.safeParse(body);
    if (!parsed.success) {
        return errorResponse(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }

    const instagramId = normalizeLeadInstagramId(parsed.data.instagramId);
    if (!instagramId) {
        return errorResponse(400, 'INVALID_REQUEST', '올바른 인스타그램 아이디가 아닙니다.');
    }

    const attribution = parsed.data.attribution ?? {};
    const userAgent = request.headers.get('user-agent')?.slice(0, 500) || undefined;

    try {
        await insertLandingLead({
            instagramId,
            rawInput: parsed.data.rawInput,
            utmSource: attribution.source,
            utmMedium: attribution.medium,
            utmCampaign: attribution.campaign,
            utmContent: attribution.content,
            utmTerm: attribution.term,
            referrer: parsed.data.referrer,
            userAgent,
        });
    } catch {
        return errorResponse(503, 'LEAD_UNAVAILABLE', '잠시 후 다시 시도해주세요.');
    }

    return NextResponse.json({ status: 'stored' }, { status: 201 });
}
