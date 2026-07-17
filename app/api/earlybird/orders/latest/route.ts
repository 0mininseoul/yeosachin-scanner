import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
    EarlybirdOrderLookupError,
    loadLatestEarlybirdOrder,
} from '@/lib/services/earlybird/order-status';

function response(status: number, body: Record<string, unknown>): NextResponse {
    return NextResponse.json(body, {
        status,
        headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            Vary: 'Cookie',
        },
    });
}

export async function GET(request: Request): Promise<NextResponse> {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return response(401, { code: 'UNAUTHORIZED', error: '로그인이 필요합니다.' });
    }

    const requestedPlan = new URL(request.url).searchParams.get('plan');
    if (requestedPlan !== null && requestedPlan !== 'basic' && requestedPlan !== 'standard') {
        return response(400, { code: 'INVALID_PLAN', error: '플랜을 확인해주세요.' });
    }

    try {
        const order = await loadLatestEarlybirdOrder(user.id, requestedPlan ?? undefined);
        if (!order) {
            return response(404, { code: 'ORDER_NOT_FOUND', error: '사전 구매 내역이 없습니다.' });
        }
        return response(200, { order });
    } catch (error) {
        if (error instanceof EarlybirdOrderLookupError) {
            return response(500, { code: error.message, error: '구매 상태를 불러오지 못했습니다.' });
        }
        return response(500, { code: 'ORDER_LOOKUP_FAILED', error: '구매 상태를 불러오지 못했습니다.' });
    }
}
