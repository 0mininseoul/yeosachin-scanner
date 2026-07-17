import Link from 'next/link';
import { CaseCard, Eyebrow } from '@/components/case-ui';
import type { EarlybirdOrderStatusDto } from '@/lib/services/earlybird/order-status';

function formatKrw(amount: number): string {
    return `${amount.toLocaleString('ko-KR')}원`;
}

function formatTimestamp(value: string): string {
    return new Intl.DateTimeFormat('ko-KR', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Seoul',
    }).format(new Date(value));
}

function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-start justify-between gap-5 border-b border-line py-3 last:border-0">
            <dt className="shrink-0 text-[12px] text-fg-mute">{label}</dt>
            <dd className="text-right text-[13px] font-medium text-fg">{value}</dd>
        </div>
    );
}

export function EarlybirdStatus({ order }: { order: EarlybirdOrderStatusDto }) {
    return (
        <>
            <Eyebrow>얼리버드 사전 구매 현황</Eyebrow>
            <h1 className="mt-3 text-[26px] font-extrabold tracking-tight text-fg">
                {order.displayStatus}
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
                결제 확정 후 실제 48시간 이내에 판독 결과를 전달합니다.
            </p>

            <CaseCard className="mt-8 p-5">
                <dl>
                    <DetailRow label="대상 계정" value={`@${order.targetInstagramId}`} />
                    <DetailRow label="구매 플랜" value={order.planName} />
                    <DetailRow
                        label="실제 결제 금액"
                        value={order.actualAmountKrw === null
                            ? '결제 확인 중'
                            : formatKrw(order.actualAmountKrw)}
                    />
                    <DetailRow label="접수 시각" value={formatTimestamp(order.acceptedAt)} />
                    <DetailRow
                        label="전달 예정"
                        value={order.dueAt
                            ? formatTimestamp(order.dueAt)
                            : '결제 확정 후 48시간 이내 전달 예정'}
                    />
                    <DetailRow
                        label="플랜 내 접수 순번"
                        value={order.planSequence === null
                            ? '결제 확인 후 배정'
                            : `${order.planSequence}번째 / 10건`}
                    />
                    <DetailRow label="현재 상태" value={order.displayStatus} />
                </dl>
            </CaseCard>

            {order.resultUrl && (
                <Link
                    href={order.resultUrl}
                    className="mt-5 flex w-full items-center justify-center bg-blood px-5 py-4 text-[14px] font-bold text-white transition-opacity hover:opacity-90"
                >
                    판독 결과 확인하기
                </Link>
            )}
        </>
    );
}
