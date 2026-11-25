interface TossBillingPayment {
    requestBillingAuth(request: {
        method: 'CARD'; successUrl: string; failUrl: string; customerEmail?: string;
    }): Promise<void>;
    destroy(): void;
}

interface TossPaymentWindow {
    on(event: 'paymentRequest' | 'cancel', callback: () => void): void;
    destroy(): void;
}

interface TossWidgets {
    setAmount(amount: { currency: 'KRW'; value: number }): Promise<void>;
    renderPaymentWindow(options: { orderName: string }): Promise<TossPaymentWindow>;
    requestPayment(request: {
        orderId: string; orderName: string; successUrl: string; failUrl: string;
    }): Promise<void>;
}

type TossFactory = (clientKey: string) => {
    payment(options: { customerKey: string }): TossBillingPayment;
    widgets(options: { customerKey: string }): TossWidgets;
};

declare global {
    interface Window { TossPayments?: TossFactory }
}

let loading: Promise<TossFactory> | undefined;

export function loadToss(): Promise<TossFactory> {
    if (window.TossPayments) return Promise.resolve(window.TossPayments);
    if (!loading) {
        loading = new Promise<TossFactory>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://js.tosspayments.com/v2/standard';
            script.async = true;
            script.onload = () => window.TossPayments
                ? resolve(window.TossPayments)
                : reject(new Error('TOSS_SDK_MISSING'));
            script.onerror = () => reject(new Error('TOSS_SDK_LOAD_FAILED'));
            document.head.append(script);
        }).catch(error => {
            loading = undefined;
            throw error;
        });
    }
    return loading;
}
