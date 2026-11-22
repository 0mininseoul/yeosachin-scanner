const BASE_URL = 'https://api.tosspayments.com';
const TIMEOUT_MS = 65_000;

export interface TossConfig { secretKey: string; clientKey: string }

/** Toss answered with a definite refusal. */
export class TossRejectedError extends Error {
    constructor(readonly code: string, readonly httpStatus: number) {
        super('TOSS_REJECTED');
        this.name = 'TossRejectedError';
    }
}

/** No usable answer; the request may have been processed. */
export class TossUnknownError extends Error {
    constructor() {
        super('TOSS_UNKNOWN');
        this.name = 'TossUnknownError';
    }
}

export interface TossPayment {
    paymentKey: string;
    orderId: string;
    status: string;
    totalAmount: number;
    balanceAmount?: number;
    approvedAt: string | null;
    cancels?: { cancelAmount: number; transactionKey: string; canceledAt: string }[] | null;
}

export interface TossBillingKey {
    billingKey: string;
    customerKey: string;
    card?: { issuerCode?: string | null; number?: string | null; cardType?: string | null } | null;
}

export function readTossConfig(env: Record<string, string | undefined> = process.env): TossConfig | null {
    const secretKey = env.CHERRY_TOSS_SECRET_KEY?.trim();
    const clientKey = env.CHERRY_TOSS_CLIENT_KEY?.trim();
    return secretKey && clientKey ? { secretKey, clientKey } : null;
}

async function tossRequest<T>(
    config: TossConfig, method: 'GET' | 'POST' | 'DELETE', path: string,
    options: { body?: Record<string, unknown>; idempotencyKey?: string; request?: typeof fetch } = {},
): Promise<T> {
    let response: Response;
    let data: Record<string, unknown>;
    try {
        response = await (options.request ?? fetch)(`${BASE_URL}${path}`, {
            method, signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString('base64')}`,
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
            },
            ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
        const text = await response.text();
        data = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
        throw new TossUnknownError();
    }
    if (response.ok) return data as T;
    const code = String(data.code ?? `HTTP_${response.status}`).slice(0, 80);
    // A request still being processed, or a server failure, has no final answer yet.
    if (response.status >= 500 || code === 'IDEMPOTENT_REQUEST_PROCESSING') throw new TossUnknownError();
    throw new TossRejectedError(code, response.status);
}

export function issueTossBillingKey(config: TossConfig, authKey: string, customerKey: string, request?: typeof fetch) {
    return tossRequest<TossBillingKey>(config, 'POST', '/v1/billing/authorizations/issue', { body: { authKey, customerKey }, request });
}

export function chargeTossBillingKey(config: TossConfig, input: {
    billingKey: string; customerKey: string; amount: number; orderId: string; orderName: string; email: string | null;
}, request?: typeof fetch) {
    return tossRequest<TossPayment>(config, 'POST', `/v1/billing/${encodeURIComponent(input.billingKey)}`, {
        body: {
            customerKey: input.customerKey, amount: input.amount, orderId: input.orderId, orderName: input.orderName,
            ...(input.email ? { customerEmail: input.email } : {}),
        },
        // One order is charged at most once, even when the request is repeated.
        idempotencyKey: `charge-${input.orderId}`, request,
    });
}

export async function findTossPayment(config: TossConfig, orderId: string, request?: typeof fetch): Promise<TossPayment | null> {
    try {
        return await tossRequest<TossPayment>(config, 'GET', `/v1/payments/orders/${encodeURIComponent(orderId)}`, { request });
    } catch (error) {
        if (error instanceof TossRejectedError && error.httpStatus === 404) return null;
        throw error;
    }
}

export function cancelTossPayment(config: TossConfig, input: {
    paymentKey: string; amount: number; reason: string; refundId: string;
}, request?: typeof fetch) {
    return tossRequest<TossPayment>(config, 'POST', `/v1/payments/${encodeURIComponent(input.paymentKey)}/cancel`, {
        body: { cancelReason: input.reason, cancelAmount: input.amount }, idempotencyKey: `refund-${input.refundId}`, request,
    });
}

export function deleteTossBillingKey(config: TossConfig, billingKey: string, request?: typeof fetch) {
    return tossRequest<Record<string, unknown>>(config, 'DELETE', `/v1/billing/${encodeURIComponent(billingKey)}`, { request });
}
