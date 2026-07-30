import type { EarlybirdOrderStatusDto } from './order-status';

const REFRESH_DELAYS_MS = [1_000, 2_000, 4_000] as const;

type StatusRefreshOrder = Pick<
    EarlybirdOrderStatusDto,
    'systemStatus' | 'requiresSupport' | 'resultUrl'
>;

export function shouldRefreshEarlybirdStatusSnapshot(
    order: StatusRefreshOrder
): boolean {
    return order.systemStatus === 'payment_pending'
        || (
            order.requiresSupport
            && (
                order.systemStatus === 'paid'
                || order.systemStatus === 'analysis_in_progress'
            )
        );
}

export function shouldAutomaticallyRedirectEarlybirdStatus(
    order: StatusRefreshOrder
): boolean {
    return !order.requiresSupport && (
        order.systemStatus === 'paid'
        || order.systemStatus === 'analysis_in_progress'
        || (order.systemStatus === 'completed' && Boolean(order.resultUrl))
    );
}

/**
 * Re-reads the dynamic server order snapshot for the short interval in which
 * Groble can confirm a payment after returning the customer to this page.
 */
export function scheduleEarlybirdStatusSnapshotRefresh(
    refresh: () => void
): () => void {
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    for (const delayMs of REFRESH_DELAYS_MS) {
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
