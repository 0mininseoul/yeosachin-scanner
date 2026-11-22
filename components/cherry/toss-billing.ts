interface TossPayment {
    requestBillingAuth(request: {
        method: 'CARD'; successUrl: string; failUrl: string; customerEmail?: string;
    }): Promise<void>;
}
type TossFactory = (clientKey: string) => { payment(options: { customerKey: string }): TossPayment };
declare global {
    interface Window { TossPayments?: TossFactory }
}

const SCRIPT_URL = 'https://js.tosspayments.com/v2/standard';

function loadToss(): Promise<TossFactory> {
    if (window.TossPayments) return Promise.resolve(window.TossPayments);
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = SCRIPT_URL;
        script.async = true;
        script.onload = () => window.TossPayments ? resolve(window.TossPayments) : reject(new Error('TOSS_SDK_MISSING'));
        script.onerror = () => reject(new Error('TOSS_SDK_LOAD_FAILED'));
        document.head.append(script);
    });
}

/** Opens the card registration window. Card numbers are entered at Toss, never on this site. */
export async function openTossBilling(input: {
    clientKey: string; customerKey: string; email: string | null; checkId: string | null;
}): Promise<void> {
    const toss = await loadToss();
    const origin = window.location.origin;
    const back = input.checkId ? `/cherry/start?check=${input.checkId}&pay=failed` : '/cherry/home?pay=failed';
    await toss(input.clientKey).payment({ customerKey: input.customerKey }).requestBillingAuth({
        method: 'CARD', successUrl: `${origin}/api/cherry/toss/return`, failUrl: `${origin}${back}`,
        ...(input.email ? { customerEmail: input.email } : {}),
    });
}
