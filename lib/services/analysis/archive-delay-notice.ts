import type { ArchiveEntry } from './archive-entries';

/**
 * Gating and re-display rules for the paid-user archive delay notice.
 *
 * Kept free of React and of Supabase so both the server component that decides
 * whether to mount the notice and the client component that decides whether to
 * open it can share one tested implementation.
 */

export const ARCHIVE_DELAY_NOTICE_STORAGE_KEY = 'archive_delay_notice_dismissal_v1';

/** "확인했어요" hides the notice for a day; the queue state may still change. */
export const ARCHIVE_DELAY_NOTICE_SNOOZE_MS = 24 * 60 * 60 * 1000;

export type DelayNoticeDismissScope = 'snoozed' | 'permanent';

/**
 * The notice is an apology for an order that has not landed yet, so it is shown
 * only to a real paying customer who is actually still waiting.
 *
 * Operator, internal-tester and E2E traffic is excluded on the same
 * `production` + `external` test the archive already applies to the account
 * deletion panel, which keeps one classification rule on this screen.
 */
export function shouldShowArchiveDelayNotice(input: {
    enabled: boolean;
    accountClass: 'production' | 'e2e_test';
    trafficClass: 'external' | 'operator' | 'e2e_test' | 'internal_tester';
    isPaidUser: boolean;
    hasPendingDelivery: boolean;
}): boolean {
    return input.enabled
        && input.accountClass === 'production'
        && input.trafficClass === 'external'
        && input.isPaidUser
        && input.hasPendingDelivery;
}

/** A paid order still owed to the user: paid but unfulfilled, or mid-analysis. */
export function hasPendingDelivery(entries: readonly ArchiveEntry[]): boolean {
    return entries.some((entry) => entry.kind === 'awaiting_delivery'
        || entry.item.status === 'pending'
        || entry.item.status === 'processing');
}

/**
 * Env kill switch. Enabled unless explicitly turned off, so the notice can be
 * retired the moment the queue recovers without waiting for a deploy.
 */
export function delayNoticeEnabledFromEnv(raw: string | undefined): boolean {
    return raw?.trim().toLowerCase() !== 'false';
}

interface StoredDismissal {
    scope: DelayNoticeDismissScope;
    until?: number;
}

export function encodeDelayNoticeDismissal(
    scope: DelayNoticeDismissScope,
    now: number,
): string {
    const payload: StoredDismissal = scope === 'permanent'
        ? { scope }
        : { scope, until: now + ARCHIVE_DELAY_NOTICE_SNOOZE_MS };
    return JSON.stringify(payload);
}

/**
 * Unreadable or expired storage means "not suppressed": a user who cleared
 * storage should see the notice again rather than silently lose it.
 */
export function isDelayNoticeSuppressed(raw: string | null, now: number): boolean {
    if (!raw) return false;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return false;
    }

    if (typeof parsed !== 'object' || parsed === null) return false;
    const { scope, until } = parsed as Partial<StoredDismissal>;

    if (scope === 'permanent') return true;
    if (scope === 'snoozed') return typeof until === 'number' && now < until;
    return false;
}
