import type { EarlybirdOrderStatusDto } from './order-status';

const PAYMENT_PENDING_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
const AUTOMATIC_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
const AUTOMATIC_TAIL_INTERVAL_MS = 60_000;
const LIFECYCLE_REFRESH_COOLDOWN_MS = 250;

export type EarlybirdStatusRefreshMode = 'payment_pending' | 'automatic';

type StatusRefreshOrder = Pick<
    EarlybirdOrderStatusDto,
    'systemStatus' | 'requiresSupport' | 'deliveryMode' | 'progressUrl' | 'resultUrl'
>;

const OWNER_STATUS_SYSTEM_STATUSES = new Set([
    'payment_pending',
    'payment_failed',
    'paid',
    'analysis_in_progress',
    'completed',
    'overflow_refund_required',
    'cancelled',
    'refund_pending',
    'refunded',
]);
const OWNER_STATUS_DELIVERY_MODES = new Set(['automatic', 'concierge', 'support']);

type OwnerStatusSnapshotHandler = (order: EarlybirdOrderStatusDto) => void;
type OwnerStatusRequest = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

function isOwnerStatusSnapshot(value: unknown): value is EarlybirdOrderStatusDto {
    if (typeof value !== 'object' || value === null) return false;
    const order = value as Partial<EarlybirdOrderStatusDto>;
    return typeof order.orderId === 'string'
        && typeof order.preflightId === 'string'
        && typeof order.targetInstagramId === 'string'
        && (order.planId === 'basic' || order.planId === 'standard')
        && (order.planName === 'Basic' || order.planName === 'Standard')
        && (order.actualAmountKrw === null || typeof order.actualAmountKrw === 'number')
        && (order.acceptedAt === null || typeof order.acceptedAt === 'string')
        && (order.dueAt === null || typeof order.dueAt === 'string')
        && (order.planSequence === null || typeof order.planSequence === 'number')
        && typeof order.systemStatus === 'string'
        && OWNER_STATUS_SYSTEM_STATUSES.has(order.systemStatus)
        && typeof order.displayStatus === 'string'
        && typeof order.requiresSupport === 'boolean'
        && typeof order.deliveryMode === 'string'
        && OWNER_STATUS_DELIVERY_MODES.has(order.deliveryMode)
        && typeof order.checkoutRecoverable === 'boolean'
        && (order.progressUrl === null || typeof order.progressUrl === 'string')
        && (order.resultUrl === null || typeof order.resultUrl === 'string');
}

export interface SingleFlightEarlybirdStatusRefresh {
    refresh: () => Promise<void>;
    stop: () => void;
}

/**
 * Polls the owner-scoped order endpoint without allowing scheduled and
 * lifecycle triggers to overlap. The endpoint is read-only; a response only
 * replaces the local DTO and never starts or mutates fulfillment.
 */
export function createSingleFlightEarlybirdStatusRefresh(
    planId: 'basic' | 'standard',
    onSnapshot: OwnerStatusSnapshotHandler,
    request: OwnerStatusRequest = (input, init) => fetch(input, init),
): SingleFlightEarlybirdStatusRefresh {
    let stopped = false;
    let controller: AbortController | null = null;
    let inFlight: Promise<void> | null = null;

    const refresh = (): Promise<void> => {
        if (stopped) return Promise.resolve();
        if (inFlight) return inFlight;

        const requestController = new AbortController();
        controller = requestController;
        const promise = request(
            `/api/earlybird/orders/latest?plan=${encodeURIComponent(planId)}`,
            { cache: 'no-store', signal: requestController.signal },
        ).then(async response => {
            if (!response.ok) return;
            const payload = await response.json() as { order?: unknown };
            if (stopped || requestController.signal.aborted) return;
            if (isOwnerStatusSnapshot(payload.order)) onSnapshot(payload.order);
        }).catch(() => {
            // Preserve the current truthful snapshot on transient read errors;
            // the bounded scheduler will try again.
        }).finally(() => {
            if (inFlight === promise) inFlight = null;
            if (controller === requestController) controller = null;
        });
        inFlight = promise;
        return promise;
    };

    const stop = () => {
        stopped = true;
        controller?.abort();
        controller = null;
        inFlight = null;
    };

    return { refresh, stop };
}

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validatedOwnerPath(value: string | null, kind: 'progress' | 'result'): string | null {
    if (!value) return null;
    const prefix = `/${kind}/`;
    if (!value.startsWith(prefix)) return null;
    const requestId = value.slice(prefix.length);
    if (!REQUEST_ID_PATTERN.test(requestId)) return null;
    return `${prefix}${encodeURIComponent(requestId)}`;
}

/**
 * Returns only the owner-scoped paths emitted by the status DTO. The server
 * builds these paths from owner-checked UUIDs, but the client still fails
 * closed so a malformed or replayed payload cannot become an open redirect.
 */
export function earlybirdStatusNavigationTarget(
    order: StatusRefreshOrder
): string | null {
    if (order.requiresSupport) return null;

    if (order.systemStatus === 'completed') {
        return validatedOwnerPath(order.resultUrl, 'result');
    }

    if (order.systemStatus === 'paid' || order.systemStatus === 'analysis_in_progress') {
        return validatedOwnerPath(order.progressUrl, 'progress');
    }

    return null;
}

export function shouldRefreshEarlybirdStatusSnapshot(
    order: StatusRefreshOrder
): boolean {
    return Boolean(earlybirdStatusRefreshMode(order));
}

export function earlybirdStatusRefreshMode(
    order: StatusRefreshOrder
): EarlybirdStatusRefreshMode | null {
    if (order.systemStatus === 'payment_pending') return 'payment_pending';
    if (
        order.systemStatus !== 'paid'
        && order.systemStatus !== 'analysis_in_progress'
    ) return null;
    if (order.requiresSupport) return null;
    if (order.deliveryMode !== 'automatic') return null;
    return earlybirdStatusNavigationTarget(order) ? null : 'automatic';
}

export function shouldAutomaticallyRedirectEarlybirdStatus(
    order: StatusRefreshOrder
): boolean {
    return Boolean(earlybirdStatusNavigationTarget(order));
}

/**
 * Re-reads the dynamic server order snapshot during the bounded burst in which
 * Groble can confirm payment and automatic fulfillment can materialize a request.
 * Both refresh modes keep a bounded-rate low-frequency tail after the burst so
 * delayed payment confirmation or request materialization can still recover
 * while this refresh mode remains active. Support and other terminal states do
 * not poll.
 */
export function scheduleEarlybirdStatusSnapshotRefresh(
    refresh: () => void,
    mode: EarlybirdStatusRefreshMode = 'payment_pending'
): () => void {
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const delays = mode === 'automatic'
        ? AUTOMATIC_REFRESH_DELAYS_MS
        : PAYMENT_PENDING_REFRESH_DELAYS_MS;
    let tailTimer: ReturnType<typeof setInterval> | null = null;
    let lifecycleCooldownTimer: ReturnType<typeof setTimeout> | null = null;

    const triggerRefresh = (source: 'scheduled' | 'lifecycle') => {
        if (cancelled) return;
        if (source === 'lifecycle' && lifecycleCooldownTimer !== null) return;
        if (source === 'lifecycle') {
            lifecycleCooldownTimer = setTimeout(() => {
                lifecycleCooldownTimer = null;
            }, LIFECYCLE_REFRESH_COOLDOWN_MS);
        }

        try {
            refresh();
        } catch {
            return;
        }
    };

    const scheduleTail = (delayMs: number) => {
        if (cancelled) return;
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (cancelled) return;
            triggerRefresh('scheduled');
            if (cancelled) return;
            tailTimer = setInterval(() => {
                if (!cancelled) triggerRefresh('scheduled');
            }, AUTOMATIC_TAIL_INTERVAL_MS);
        }, delayMs);
        timers.add(timer);
    };

    for (const delayMs of delays) {
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (!cancelled) triggerRefresh('scheduled');
        }, delayMs);
        timers.add(timer);
    }

    scheduleTail(
        delays[delays.length - 1] + AUTOMATIC_TAIL_INTERVAL_MS,
    );

    const stopTimers = () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        if (tailTimer !== null) {
            clearInterval(tailTimer);
            tailTimer = null;
        }
        if (lifecycleCooldownTimer !== null) {
            clearTimeout(lifecycleCooldownTimer);
            lifecycleCooldownTimer = null;
        }
    };

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') triggerRefresh('lifecycle');
        };
        const handleFocus = () => triggerRefresh('lifecycle');
        const handlePageShow = () => triggerRefresh('lifecycle');

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('focus', handleFocus);
        window.addEventListener('pageshow', handlePageShow);

        return () => {
            cancelled = true;
            stopTimers();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('focus', handleFocus);
            window.removeEventListener('pageshow', handlePageShow);
        };
    }

    return () => {
        cancelled = true;
        stopTimers();
    };
}
