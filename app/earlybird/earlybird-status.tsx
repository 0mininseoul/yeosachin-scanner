'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BrandMark, CaseCard, Eyebrow, PrimaryButton } from '@/components/case-ui';
import { useAuth } from '@/hooks/useAuth';
import type { EarlybirdOrderStatusDto } from '@/lib/services/earlybird/order-status';
import { EVENTS, flushAnalytics, trackEvent } from '@/lib/services/analytics';
import {
    availableAnalyticsStorage,
    tryClaimAnalyticsEvent,
} from '@/lib/services/analytics-funnel';
import {
    earlybirdStatusEventKey,
    paymentConfirmationEventKey,
} from '@/lib/services/earlybird/analytics-state';
import {
    createSingleFlightEarlybirdStatusRefresh,
    earlybirdStatusNavigationTarget,
    earlybirdStatusRefreshMode,
    scheduleEarlybirdStatusSnapshotRefresh,
} from '@/lib/services/earlybird/payment-pending-status-refresh';
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

const CONCIERGE_ANALYSIS_COPY =
    '판독 결과가 완성되면 2일 이내에 가입하신 이메일로 결과 링크를 보내드릴게요.';
const SUPPORT_COPY =
    '결제 확인이 지연되고 있어요. 같은 화면이 계속되면 고객센터로 문의해주세요.';

const BRIDGE_TRACKS = [
    '맞팔·AI 판독',
    '위험 단서 수집',
    '위험도·총평 정리',
] as const;

function AutomaticFulfillmentProgressShell() {
    return (
        <div role="status" data-earlybird-progress-bridge>
            <Eyebrow className="mt-8 justify-center">판독 진행 중</Eyebrow>
            <div className="relative mt-3.5 h-44 w-44 self-center">
                <div
                    className="anim-radar absolute inset-0 rounded-full"
                    style={{
                        background:
                            'conic-gradient(from 0deg, transparent 0deg, rgba(228,19,42,0.30) 46deg, transparent 64deg)',
                    }}
                />
                <div
                    className="absolute inset-0 rounded-full"
                    style={{
                        background: 'var(--color-line)',
                        WebkitMask: 'radial-gradient(circle, transparent 0 76px, #000 76px)',
                        mask: 'radial-gradient(circle, transparent 0 76px, #000 76px)',
                    }}
                />
                <div className="absolute inset-[24px] rounded-full border border-line" />
                <div className="absolute inset-[48px] rounded-full border border-line/70" />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-[24px] font-bold leading-none tracking-[-0.03em] text-fg">
                        준비 중
                    </span>
                </div>
            </div>
            <p className="mt-2.5 text-center text-[11px] text-fg-mute">약 5~10분</p>
            <p className="mt-3.5 text-center text-[12px] leading-relaxed text-fg-dim" aria-live="polite">
                판독을 자동으로 준비하고 있습니다.
            </p>
            <div className="mt-4 w-full">
                {BRIDGE_TRACKS.map((label, index) => (
                    <div
                        key={label}
                        className={`flex items-center gap-3 py-2.5 ${
                            index === BRIDGE_TRACKS.length - 1 ? '' : 'border-b border-line'
                        }`}
                    >
                        <span aria-hidden="true" className="w-0.5 self-stretch bg-line-2" />
                        <span className="text-[13.5px] text-fg-mute">{label}</span>
                        <span className="num ml-auto text-[11.5px] font-bold text-fg-mute">대기</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export function EarlybirdStatus({
    order,
}: {
    order: EarlybirdOrderStatusDto;
}) {
    const trackedRef = useRef(new Set<string>());
    const router = useRouter();
    const { user, loading: authLoading } = useAuth();
    const [ownerOrder, setOwnerOrder] = useState(order);
    const [notifyModalOpen, setNotifyModalOpen] = useState(false);
    const [checkoutRecoveryPending, setCheckoutRecoveryPending] = useState(false);
    const [checkoutRecoveryError, setCheckoutRecoveryError] = useState<string | null>(null);
    const checkoutRecoveryGuardRef = useRef({ inFlight: false });
    const currentOrder = ownerOrder;
    const refreshMode = earlybirdStatusRefreshMode(currentOrder);
    const nextUrl = earlybirdStatusNavigationTarget(currentOrder);
    const isAutomaticFulfillmentBridge = currentOrder.deliveryMode === 'automatic'
        && Boolean(nextUrl);
    const isPaidDeliveryPending = currentOrder.systemStatus === 'paid'
        || currentOrder.systemStatus === 'analysis_in_progress';
    const isAutomaticPendingBridge = currentOrder.deliveryMode === 'automatic'
        && !currentOrder.requiresSupport
        && isPaidDeliveryPending
        && !nextUrl;
    const navigationTargetRef = useRef<string | null>(null);

    useEffect(() => {
        setOwnerOrder(order);
    }, [order]);

    useEffect(() => {
        if (!refreshMode) return;
        const ownerStatus = createSingleFlightEarlybirdStatusRefresh(
            currentOrder.planId,
            setOwnerOrder,
        );
        const stopSchedule = scheduleEarlybirdStatusSnapshotRefresh(
            () => { void ownerStatus.refresh(); },
            refreshMode,
        );
        // A paid return can land in the narrow admission window before the
        // first scheduled tick. Read once immediately, then keep the bounded
        // burst and tail cadence for late materialization.
        void ownerStatus.refresh();
        return () => {
            stopSchedule();
            ownerStatus.stop();
        };
    }, [currentOrder.planId, refreshMode]);

    useEffect(() => {
        if (!notifyModalOpen) return;
        const timer = setTimeout(() => router.push('/'), 2400);
        return () => clearTimeout(timer);
    }, [notifyModalOpen, router]);

    useEffect(() => {
        // The server-rendered order is owner-bound, but the browser SDK can still
        // be anonymous while Supabase restores its session. Never send an order
        // event during that gap: a later setUserId cannot repair an already sent
        // event's identity.
        if (authLoading || !user?.id) return;
        const properties = {
            order_id: currentOrder.orderId,
            plan_id: currentOrder.planId,
            ...(currentOrder.actualAmountKrw === null
                ? {}
                : { amount_krw: currentOrder.actualAmountKrw }),
            status: currentOrder.systemStatus,
        };
        const statusKey = earlybirdStatusEventKey(currentOrder.orderId, currentOrder.systemStatus);
        if (!trackedRef.current.has(statusKey)) {
            trackedRef.current.add(statusKey);
            if (tryClaimAnalyticsEvent(availableAnalyticsStorage(), statusKey)) {
                trackEvent(EVENTS.EARLYBIRD_STATUS_VIEWED, properties);
            }
        }

        const paymentKey = paymentConfirmationEventKey(currentOrder.orderId, currentOrder.systemStatus);
        if (paymentKey && !trackedRef.current.has(paymentKey)) {
            trackedRef.current.add(paymentKey);
            if (tryClaimAnalyticsEvent(availableAnalyticsStorage(), paymentKey)) {
                trackEvent(EVENTS.PAYMENT_CONFIRMED_VIEWED, properties);
            }
        }
    }, [authLoading, currentOrder, user?.id]);

    useEffect(() => {
        if (!nextUrl) return;
        if (navigationTargetRef.current === nextUrl) return;
        let active = true;
        void flushAnalytics().finally(() => {
            if (active) navigationTargetRef.current = nextUrl;
            if (active) router.replace(nextUrl);
        });
        return () => {
            active = false;
        };
    }, [nextUrl, router]);

    const handleCheckoutRecovery = async () => {
        setCheckoutRecoveryError(null);
        await recoverPendingEarlybirdCheckout(
            currentOrder.preflightId,
            currentOrder.planId,
            checkoutRecoveryGuardRef.current,
            {
                request: fetch,
                redirectCheckout: nextUrl => {
                    trackEvent(EVENTS.CHECKOUT_REDIRECTED, {
                        plan_id: currentOrder.planId,
                        preflight_id: currentOrder.preflightId,
                        ...(currentOrder.actualAmountKrw === null
                            ? {}
                            : { amount_krw: currentOrder.actualAmountKrw }),
                    });
                    window.location.assign(nextUrl);
                },
                setPending: setCheckoutRecoveryPending,
                showError: setCheckoutRecoveryError,
            }
        );
    };

    if (currentOrder.requiresSupport) {
        return (
            <CaseCard className="mt-8 p-7 text-center" bracket="var(--color-amber)">
                <Eyebrow className="justify-center">결제 확인</Eyebrow>
                <h1 className="mt-3 text-[22px] font-extrabold tracking-tight text-fg">
                    판독 상태를 확인하고 있어요
                </h1>
                <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">
                    {SUPPORT_COPY}
                </p>
            </CaseCard>
        );
    }

    if (nextUrl) {
        const isResultNavigation = nextUrl.startsWith('/result/');
        return (
            <div role="status">
                <CaseCard className="mt-8 p-7 text-center">
                    <Eyebrow className="justify-center">결제 확인</Eyebrow>
                    <h1 className="mt-3 text-[22px] font-extrabold tracking-tight text-fg">
                        {isAutomaticFulfillmentBridge
                            ? '판독을 자동으로 시작하고 있어요'
                            : isResultNavigation
                                ? '판독 결과로 이동하고 있어요'
                                : '판독 진행 화면으로 이동하고 있어요'}
                    </h1>
                    <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">
                        잠시만 기다리면 진행 화면으로 이어집니다.
                    </p>
                </CaseCard>
            </div>
        );
    }

    if (isAutomaticPendingBridge) {
        return <AutomaticFulfillmentProgressShell />;
    }

    if (isPaidDeliveryPending) {
        return (
            <div role="status">
                <CaseCard className="mt-8 p-7 text-center">
                    <Eyebrow className="justify-center">결제 완료</Eyebrow>
                    <h1 className="mt-3 text-[22px] font-extrabold tracking-tight text-fg">
                        결제가 완료되었어요
                    </h1>
                    <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">
                        {CONCIERGE_ANALYSIS_COPY}
                    </p>
                </CaseCard>
            </div>
        );
    }

    return (
        <>
            <Eyebrow>얼리버드 사전 구매 현황</Eyebrow>
            <h1 className="mt-3 text-[26px] font-extrabold tracking-tight text-fg">
                {currentOrder.displayStatus}
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
                위장여사친 판독기를 이용해주셔서 감사합니다.
                <br />
                결제가 확정되면 판독이 자동으로 시작됩니다.
            </p>

            <CaseCard className="mt-8 p-5">
                <dl data-amp-block>
                    <DetailRow label="대상 계정" value={`@${currentOrder.targetInstagramId}`} />
                    <DetailRow label="구매 플랜" value={currentOrder.planName} />
                    <DetailRow
                        label="접수 시각"
                        value={currentOrder.acceptedAt
                            ? formatKstDateTime(currentOrder.acceptedAt)
                            : '결제 확인 후 표시'}
                    />
                    <DetailRow label="현재 상태" value={currentOrder.displayStatus} />
                </dl>
            </CaseCard>

            {currentOrder.resultUrl && currentOrder.systemStatus === 'completed' && nextUrl ? (
                <Link
                    href={currentOrder.resultUrl}
                    data-amp-block
                    className="mt-5 flex w-full items-center justify-center bg-blood px-5 py-4 text-[14px] font-bold text-white transition-opacity hover:opacity-90"
                >
                    판독 결과 확인하기
                </Link>
            ) : currentOrder.systemStatus === 'payment_pending'
                && currentOrder.checkoutRecoverable ? (
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
                            data-amp-mask
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
            ) : currentOrder.systemStatus === 'cancelled' ? (
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
