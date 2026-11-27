'use client';

import { useEffect, useRef, useState } from 'react';
import { PrimaryButton } from '@/components/case-ui';
import { loadToss } from '@/lib/services/toss/browser';
import { CHERRY_REVIEW_CHECKOUT_PATH } from '@/lib/constants/cherry-public-url';

type Props = { clientKey: string | null } & (
    { product: 'analyzer'; amount: number; orderName: string }
    | { product: 'cherry' }
);

export function TossReviewButton(props: Props) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const attempt = useRef<{ disposed: boolean; close?: () => void } | null>(null);
    const isBilling = props.product === 'cherry';

    useEffect(() => () => {
        if (attempt.current) {
            attempt.current.disposed = true;
            attempt.current.close?.();
        }
    }, []);

    async function open() {
        const keyPrefix = isBilling ? 'test_ck_' : 'test_gck_';
        if (!props.clientKey?.startsWith(keyPrefix) || busy) return;
        setError(false);
        setBusy(true);
        const current: NonNullable<typeof attempt.current> = { disposed: false };
        attempt.current = current;

        function finish(failed = false) {
            if (current.disposed) return;
            current.disposed = true;
            attempt.current = null;
            setError(failed);
            setBusy(false);
        }

        const returnPath = isBilling ? `${CHERRY_REVIEW_CHECKOUT_PATH}/return` : '/login/pg-review/return';
        const returnUrl = new URL(returnPath, window.location.origin);
        returnUrl.searchParams.set('result', 'authorized');
        const successUrl = returnUrl.toString();
        returnUrl.searchParams.set('result', 'failed');
        const failUrl = returnUrl.toString();

        try {
            const toss = (await loadToss())(props.clientKey);
            if (current.disposed) return;
            if (props.product === 'cherry') {
                const payment = toss.payment({ customerKey: crypto.randomUUID() });
                current.close = () => {
                    try {
                        payment.destroy();
                    } catch {
                        // Toss can finish the request before React removes this button.
                    }
                };
                await payment.requestBillingAuth({
                    method: 'CARD', successUrl, failUrl,
                });
                finish();
                return;
            }

            const { amount, orderName } = props;
            const widgets = toss.widgets({ customerKey: 'ANONYMOUS' });
            await widgets.setAmount({ currency: 'KRW', value: amount });
            if (current.disposed) return;
            const paymentWindow = await widgets.renderPaymentWindow({ orderName });
            if (current.disposed) {
                paymentWindow.destroy();
                return;
            }
            current.close = () => paymentWindow.destroy();
            const orderId = `review-${crypto.randomUUID()}`;
            paymentWindow.on('cancel', () => finish());
            paymentWindow.on('paymentRequest', async () => {
                if (current.disposed) return;
                try {
                    await widgets.requestPayment({ orderId, orderName, successUrl, failUrl });
                } catch {
                    if (current.disposed) return;
                    paymentWindow.destroy();
                    finish(true);
                }
            });
        } catch {
            finish(true);
        }
    }

    if (!props.clientKey) {
        return <p role="status" className={isBilling ? 'ch-note' : 'mt-4 text-sm text-fg-dim'}>현재 테스트 결제창을 이용할 수 없습니다.</p>;
    }

    return (
        <>
            {isBilling
                ? <button type="button" className="ch-button ch-checkout-cta" disabled={busy} onClick={open}>
                    {busy ? '카드 등록창 여는 중…' : '카드 등록하기'}
                </button>
                : <PrimaryButton type="button" className="mt-4" disabled={busy} onClick={open}>테스트 결제창 열기</PrimaryButton>}
            {error && <p role="alert" className={isBilling ? 'ch-error' : 'mt-3 text-sm text-fg'}>토스페이먼츠 창을 열 수 없습니다. 다시 시도해 주세요.</p>}
        </>
    );
}
