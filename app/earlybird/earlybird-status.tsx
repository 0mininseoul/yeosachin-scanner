'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BrandMark, CaseCard, Eyebrow, PrimaryButton } from '@/components/case-ui';
import type { EarlybirdOrderStatusDto } from '@/lib/services/earlybird/order-status';
import { EVENTS, trackEvent } from '@/lib/services/analytics';
import {
    availableAnalyticsStorage,
    tryClaimAnalyticsEvent,
} from '@/lib/services/analytics-funnel';
import {
    earlybirdStatusEventKey,
    paymentConfirmationEventKey,
} from '@/lib/services/earlybird/analytics-state';
import { recoverPendingEarlybirdCheckout } from '@/lib/services/earlybird/ui-state';
import { formatKstDateTime } from '@/lib/services/date-time-presentation';

function DetailRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-start justify-between gap-5 border-b border-line py-3 last:border-0">
            <dt className="shrink-0 text-[12px] text-fg-mute">{label}</dt>
            <dd className="text-right text-[13px] font-medium text-fg">{value}</dd>
        </div>
    );
}

export function EarlybirdStatus({ order }: { order: EarlybirdOrderStatusDto }) {
    const trackedRef = useRef(new Set<string>());
    const router = useRouter();
    const [notifyModalOpen, setNotifyModalOpen] = useState(false);
    const [checkoutRecoveryPending, setCheckoutRecoveryPending] = useState(false);
    const [checkoutRecoveryError, setCheckoutRecoveryError] = useState<string | null>(null);
    const checkoutRecoveryGuardRef = useRef({ inFlight: false });
    const isAutomaticFulfillmentBridge = !order.requiresSupport && (
        order.systemStatus === 'paid'
        || order.systemStatus === 'analysis_in_progress'
        || (order.systemStatus === 'completed' && Boolean(order.resultUrl))
    );

    useEffect(() => {
        if (!isAutomaticFulfillmentBridge) return;
        const nextUrl = order.resultUrl ?? order.progressUrl;
        if (nextUrl) {
            router.replace(nextUrl);
            return;
        }
        const timer = window.setTimeout(() => router.refresh(), 1_500);
        return () => window.clearTimeout(timer);
    }, [isAutomaticFulfillmentBridge, order.progressUrl, order.resultUrl, router]);

    useEffect(() => {
        if (!notifyModalOpen) return;
        const timer = setTimeout(() => router.push('/'), 2400);
        return () => clearTimeout(timer);
    }, [notifyModalOpen, router]);

    useEffect(() => {
        const properties = {
            order_id: order.orderId,
            plan_id: order.planId,
            ...(order.actualAmountKrw === null
                ? {}
                : { amount_krw: order.actualAmountKrw }),
            status: order.systemStatus,
        };
        const statusKey = earlybirdStatusEventKey(order.orderId, order.systemStatus);
        if (!trackedRef.current.has(statusKey)) {
            trackedRef.current.add(statusKey);
            if (tryClaimAnalyticsEvent(availableAnalyticsStorage(), statusKey)) {
                trackEvent(EVENTS.EARLYBIRD_STATUS_VIEWED, properties);
            }
        }

        const paymentKey = paymentConfirmationEventKey(order.orderId, order.systemStatus);
        if (paymentKey && !trackedRef.current.has(paymentKey)) {
            trackedRef.current.add(paymentKey);
            if (tryClaimAnalyticsEvent(availableAnalyticsStorage(), paymentKey)) {
                trackEvent(EVENTS.PAYMENT_CONFIRMED_VIEWED, properties);
            }
        }
    }, [order]);

    const handleCheckoutRecovery = async () => {
        setCheckoutRecoveryError(null);
        await recoverPendingEarlybirdCheckout(
            order.preflightId,
            checkoutRecoveryGuardRef.current,
            {
                request: fetch,
                redirectCheckout: checkoutUrl => window.location.assign(checkoutUrl),
                setPending: setCheckoutRecoveryPending,
                showError: setCheckoutRecoveryError,
            }
        );
    };

    if (order.requiresSupport) {
        return (
            <CaseCard className="mt-8 p-7 text-center" bracket="var(--color-amber)">
                <Eyebrow className="justify-center">결제 확인</Eyebrow>
                <h1 className="mt-3 text-[22px] font-extrabold tracking-tight text-fg">
                    판독 상태를 확인하고 있어요
                </h1>
                <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">
                    확인이 끝나는 대로 가입하신 이메일로 안내해드릴게요.
                </p>
            </CaseCard>
        );
    }

    if (isAutomaticFulfillmentBridge) {
        return (
            <div role="status">
                <CaseCard className="mt-8 p-7 text-center">
                    <Eyebrow className="justify-center">결제 확인</Eyebrow>
                    <h1 className="mt-3 text-[22px] font-extrabold tracking-tight text-fg">
                        판독을 자동으로 시작하고 있어요
                    </h1>
                    <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">
                        잠시만 기다리면 진행 화면으로 이어집니다.
                    </p>
                </CaseCard>
            </div>
        );
    }

    return (
        <>
            <Eyebrow>얼리버드 사전 구매 현황</Eyebrow>
            <h1 className="mt-3 text-[26px] font-extrabold tracking-tight text-fg">
                {order.displayStatus}
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
                위장여사친 판독기를 이용해주셔서 감사합니다.
                <br />
                결제가 확정되면 판독이 자동으로 시작됩니다.
            </p>

            <CaseCard className="mt-8 p-5">
                <dl data-amp-block>
                    <DetailRow label="대상 계정" value={`@${order.targetInstagramId}`} />
                    <DetailRow label="구매 플랜" value={order.planName} />
                    <DetailRow
                        label="접수 시각"
                        value={order.acceptedAt
                            ? formatKstDateTime(order.acceptedAt)
                            : '결제 확인 후 표시'}
                    />
                    <DetailRow label="현재 상태" value={order.displayStatus} />
                </dl>
            </CaseCard>

            {order.resultUrl ? (
                <Link
                    href={order.resultUrl}
                    className="mt-5 flex w-full items-center justify-center bg-blood px-5 py-4 text-[14px] font-bold text-white transition-opacity hover:opacity-90"
                >
                    판독 결과 확인하기
                </Link>
            ) : order.systemStatus === 'payment_pending' ? (
                <>
                    <PrimaryButton
                        className="mt-5"
                        disabled={checkoutRecoveryPending}
                        onClick={handleCheckoutRecovery}
                    >
                        {checkoutRecoveryPending ? '결제창 불러오는 중…' : '결제 계속하기'}
                    </PrimaryButton>
                    {checkoutRecoveryError && (
                        <p
                            className="mt-3 text-center text-[12px] leading-relaxed text-blood"
                            role="alert"
                        >
                            {checkoutRecoveryError}
                        </p>
                    )}
                    <button
                        type="button"
                        className="mt-4 w-full text-center text-[13px] font-semibold text-fg-dim"
                        onClick={() => setNotifyModalOpen(true)}
                    >
                        이메일 알림 받기
                    </button>
                </>
            ) : order.systemStatus === 'cancelled' ? (
                <CaseCard className="mt-5 p-4" bracket="var(--color-amber)">
                    <p className="text-[13px] font-bold text-amber" role="status">
                        취소된 주문입니다.
                    </p>
                    <p className="mt-2 text-[12px] leading-relaxed text-fg-dim">
                        결제를 이미 진행했다면 새로 결제하지 말고,
                        결제 상태가 반영될 때까지 기다려주세요.
                    </p>
                </CaseCard>
            ) : (
                <PrimaryButton className="mt-5" onClick={() => setNotifyModalOpen(true)}>
                    이메일 알림 받기
                </PrimaryButton>
            )}

            {notifyModalOpen && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-5"
                    role="dialog"
                    aria-modal="true"
                    aria-label="이메일 알림 신청 완료"
                >
                    <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm" />
                    <div className="relative w-full max-w-[380px] border border-line bg-ink-2 px-6 py-8 text-center shadow-2xl">
                        <div className="mx-auto flex h-14 w-14 items-center justify-center border border-line bg-ink">
                            <BrandMark size={26} className="text-blood" />
                        </div>
                        <h2 className="mt-5 text-[19px] font-extrabold tracking-tight text-fg">
                            신청이 완료되었습니다
                        </h2>
                        <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
                            판독이 완료되면 가입하신 이메일로
                            <br />
                            결과를 안내해드릴게요.
                        </p>
                        <p className="mt-5 text-[12px] text-fg-mute">잠시 후 처음 화면으로 돌아갑니다…</p>
                    </div>
                </div>
            )}
        </>
    );
}
