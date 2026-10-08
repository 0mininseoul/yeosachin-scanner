import { z } from 'zod';
import { planQuoteV1Schema } from '@/lib/contracts/analysis-v2';
import { isSafeDevUiCheckoutUrl } from '@/lib/services/earlybird/checkout-continuation';

const uuid = z.string().uuid();
const orderView = z.object({
    orderId: uuid, targetInstagramId: z.string().min(1).max(30), planId: z.enum(['basic', 'standard']),
    price: planQuoteV1Schema.shape.price, fixtureScenario: z.enum(['complete', 'partial', 'failed', 'empty']),
    status: z.enum(['pending', 'expired', 'success', 'cancel', 'failure']),
    createdAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }), completedAt: z.string().datetime({ offset: true }).nullable(),
    run: z.object({ runId: uuid }).nullable(), runStatus: z.enum(['processing', 'completed', 'failed', 'expired']).nullable(),
    nextUrl: z.string(), simulation: z.literal(true),
}).refine(order => order.status === 'success'
    ? Boolean(order.run && order.runStatus && (order.nextUrl === `/progress/${order.run.runId}` || order.nextUrl === `/result/${order.run.runId}`))
    : order.run === null && order.runStatus === null && order.nextUrl === `/dev-ui/checkout/${order.orderId}` && isSafeDevUiCheckoutUrl(order.nextUrl));

export type DevUiOrderView = z.infer<typeof orderView>;
export const DEV_UI_ORDER_STATUS: Record<DevUiOrderView['status'], string> = {
    pending: '결제 대기', expired: '만료', success: '모의 결제 완료', cancel: '모의 결제 취소', failure: '모의 결제 실패',
};
export const DEV_UI_SCENARIO_LABELS: Record<DevUiOrderView['fixtureScenario'], string> = {
    complete: '완료', partial: '부분 수집', failed: '분석 실패', empty: '빈 결과',
};

export function readDevUiOrderPayload(payload: unknown): DevUiOrderView {
    const parsed = z.object({ simulation: z.literal(true), order: orderView }).safeParse(payload);
    if (!parsed.success) throw new Error('테스트 응답을 확인할 수 없습니다.');
    return parsed.data.order;
}
export function readDevUiOrderListPayload(payload: unknown): DevUiOrderView[] {
    const parsed = z.object({ simulation: z.literal(true), orders: z.array(orderView).max(100) }).safeParse(payload);
    if (!parsed.success) throw new Error('테스트 응답을 확인할 수 없습니다.');
    return parsed.data.orders;
}
export function devUiHttpError(status: number): Error {
    return new Error(status === 401 ? '로그인이 필요합니다.' : status === 403 ? '등록된 테스트 계정과 접근 권한을 확인해주세요.'
        : status === 410 ? '테스트 요청이 만료되었습니다. 새 사전 점검을 시작해주세요.' : '테스트 조회에 실패했습니다. 잠시 후 다시 시도해주세요.');
}

export function readDevUiCompletion(payload: unknown, expectedOrderId: string) {
    const parsed = z.discriminatedUnion('status', [
        z.object({ status: z.literal('success'), orderId: uuid, runId: uuid, replayed: z.boolean() }),
        z.object({ status: z.literal('cancel'), orderId: uuid, runId: z.null(), replayed: z.boolean() }),
        z.object({ status: z.literal('failure'), orderId: uuid, runId: z.null(), replayed: z.boolean() }),
    ]).safeParse(payload);
    if (!parsed.success || parsed.data.orderId !== expectedOrderId) throw new Error('모의 결제 응답을 확인할 수 없습니다.');
    return parsed.data;
}
