import type { EarlybirdOrderStatusDto } from './order-status';

const PAYMENT_PENDING_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const AUTOMATIC_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;

export type EarlybirdStatusRefreshMode = 'payment_pending' | 'automatic' | 'support';

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
    if (order.requiresSupport) return 'support';
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
 * Automatic fulfillment gets a bounded roughly 60-second low-load window;
 * payment confirmation and support recovery retain the shorter canary window.
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

    for (const delayMs of delays) {
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (!cancelled) refresh();
        }, delayMs);
        timers.add(timer);
    }

    return () => {
        cancelled = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
    };
}
