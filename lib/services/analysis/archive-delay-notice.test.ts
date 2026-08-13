import { describe, expect, it } from 'vitest';
import type { ArchiveEntry } from './archive-entries';
import type { OwnerAnalysisHistoryItemV1 } from './owner-history';
import {
    ARCHIVE_DELAY_NOTICE_SNOOZE_MS,
    delayNoticeEnabledFromEnv,
    encodeDelayNoticeDismissal,
    hasPendingDelivery,
    isDelayNoticeSuppressed,
    shouldShowArchiveDelayNotice,
} from './archive-delay-notice';

const ELIGIBLE = {
    enabled: true,
    accountClass: 'production',
    trafficClass: 'external',
    isPaidUser: true,
    hasPendingDelivery: true,
} as const;

function analysisEntry(status: OwnerAnalysisHistoryItemV1['status']): ArchiveEntry {
    return { kind: 'analysis', item: { status } as OwnerAnalysisHistoryItemV1 };
}

const awaitingEntry: ArchiveEntry = {
    kind: 'awaiting_delivery',
    orderId: 'order-1',
    targetInstagramId: 'sample_target',
    planId: 'basic',
    createdAt: null,
};

describe('shouldShowArchiveDelayNotice', () => {
    it('shows for a paying external production user who is still waiting', () => {
        expect(shouldShowArchiveDelayNotice(ELIGIBLE)).toBe(true);
    });

    it('never shows to an unpaid user', () => {
        expect(shouldShowArchiveDelayNotice({ ...ELIGIBLE, isPaidUser: false })).toBe(false);
    });

    it('never shows to operator, internal tester or e2e traffic', () => {
        for (const trafficClass of ['operator', 'internal_tester', 'e2e_test'] as const) {
            expect(shouldShowArchiveDelayNotice({ ...ELIGIBLE, trafficClass })).toBe(false);
        }
    });

    it('never shows to a non-production account class', () => {
        expect(shouldShowArchiveDelayNotice({ ...ELIGIBLE, accountClass: 'e2e_test' })).toBe(false);
    });

    it('does not apologise to a paying user whose results all landed', () => {
        expect(shouldShowArchiveDelayNotice({ ...ELIGIBLE, hasPendingDelivery: false })).toBe(false);
    });

    it('is suppressed entirely by the kill switch', () => {
        expect(shouldShowArchiveDelayNotice({ ...ELIGIBLE, enabled: false })).toBe(false);
    });
});

describe('hasPendingDelivery', () => {
    it('counts a paid order whose analysis row does not exist yet', () => {
        expect(hasPendingDelivery([awaitingEntry])).toBe(true);
    });

    it('counts pending and processing analyses', () => {
        expect(hasPendingDelivery([analysisEntry('pending')])).toBe(true);
        expect(hasPendingDelivery([analysisEntry('processing')])).toBe(true);
    });

    it('does not count a fully delivered archive', () => {
        expect(hasPendingDelivery([analysisEntry('completed')])).toBe(false);
        expect(hasPendingDelivery([])).toBe(false);
    });
});

describe('delayNoticeEnabledFromEnv', () => {
    it('defaults to enabled when unset so the notice survives a missing env', () => {
        expect(delayNoticeEnabledFromEnv(undefined)).toBe(true);
        expect(delayNoticeEnabledFromEnv('')).toBe(true);
        expect(delayNoticeEnabledFromEnv('true')).toBe(true);
    });

    it('is turned off by an explicit false, regardless of casing or padding', () => {
        expect(delayNoticeEnabledFromEnv('false')).toBe(false);
        expect(delayNoticeEnabledFromEnv('  FALSE  ')).toBe(false);
    });
});

describe('delay notice dismissal storage', () => {
    const now = 1_760_000_000_000;

    it('hides the notice for 24 hours after 확인했어요', () => {
        const stored = encodeDelayNoticeDismissal('snoozed', now);
        expect(isDelayNoticeSuppressed(stored, now)).toBe(true);
        expect(isDelayNoticeSuppressed(stored, now + ARCHIVE_DELAY_NOTICE_SNOOZE_MS - 1)).toBe(true);
    });

    it('lets the notice return once the snooze expires', () => {
        const stored = encodeDelayNoticeDismissal('snoozed', now);
        expect(isDelayNoticeSuppressed(stored, now + ARCHIVE_DELAY_NOTICE_SNOOZE_MS)).toBe(false);
    });

    it('hides the notice forever after 다시 보지 않기', () => {
        const stored = encodeDelayNoticeDismissal('permanent', now);
        expect(isDelayNoticeSuppressed(stored, now)).toBe(true);
        expect(isDelayNoticeSuppressed(stored, now + 10 * ARCHIVE_DELAY_NOTICE_SNOOZE_MS)).toBe(true);
    });

    it('treats missing or corrupt storage as not suppressed', () => {
        expect(isDelayNoticeSuppressed(null, now)).toBe(false);
        expect(isDelayNoticeSuppressed('not json', now)).toBe(false);
        expect(isDelayNoticeSuppressed('"a string"', now)).toBe(false);
        expect(isDelayNoticeSuppressed('{"scope":"snoozed"}', now)).toBe(false);
        expect(isDelayNoticeSuppressed('{"scope":"bogus"}', now)).toBe(false);
    });
});
