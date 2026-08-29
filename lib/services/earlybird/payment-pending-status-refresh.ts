import type { EarlybirdOrderStatusDto } from './order-status';

const PAYMENT_PENDING_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const AUTOMATIC_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
const AUTOMATIC_TAIL_INTERVAL_MS = 60_000;

export type EarlybirdStatusRefreshMode = 'payment_pending' | 'automatic';

type StatusRefreshOrder = Pick<
    EarlybirdOrderStatusDto,
    'systemStatus' | 'requiresSupport' | 'deliveryMode' | 'progressUrl' | 'resultUrl'
>;

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
 * Re-reads the dynamic server order snapshot for the short interval in which
 * Groble can confirm payment and automatic fulfillment can materialize a request.
 * Automatic fulfillment keeps a bounded-rate low-frequency tail after the
 * burst so a delayed request materialization can still recover while this
 * refresh mode remains active. Payment confirmation retains the short canary
 * window; support and all other terminal states do not poll.
 */
export function scheduleEarlybirdStatusSnapshotRefresh(
    refresh: () => void | PromiseLike<void>,
    mode: EarlybirdStatusRefreshMode = 'payment_pending'
): () => void {
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const delays = mode === 'automatic'
        ? AUTOMATIC_REFRESH_DELAYS_MS
        : PAYMENT_PENDING_REFRESH_DELAYS_MS;
    let tailTimer: ReturnType<typeof setInterval> | null = null;
    let lifecycleRefreshPending = false;
    let refreshInFlight: Promise<void> | null = null;

    const clearLifecycleRefreshPending = () => {
        lifecycleRefreshPending = false;
    };

    const triggerRefresh = (source: 'scheduled' | 'lifecycle') => {
        if (cancelled || refreshInFlight) return;
        if (lifecycleRefreshPending) return;
        if (source === 'lifecycle') lifecycleRefreshPending = true;

        let result: void | PromiseLike<void>;
        try {
            result = refresh();
        } catch {
            if (source === 'lifecycle') queueMicrotask(clearLifecycleRefreshPending);
            return;
        }

        if (result && typeof result.then === 'function') {
            const pending = Promise.resolve(result);
            refreshInFlight = pending;
            void pending.then(
                () => {
                    if (refreshInFlight === pending) refreshInFlight = null;
                    if (source === 'lifecycle') clearLifecycleRefreshPending();
                },
                () => {
                    if (refreshInFlight === pending) refreshInFlight = null;
                    if (source === 'lifecycle') clearLifecycleRefreshPending();
                },
            );
        } else if (source === 'lifecycle') {
            queueMicrotask(clearLifecycleRefreshPending);
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

    if (mode === 'automatic') {
        scheduleTail(
            AUTOMATIC_REFRESH_DELAYS_MS[AUTOMATIC_REFRESH_DELAYS_MS.length - 1]
                + AUTOMATIC_TAIL_INTERVAL_MS,
        );
    }

    const stopTimers = () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        if (tailTimer !== null) {
            clearInterval(tailTimer);
            tailTimer = null;
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
