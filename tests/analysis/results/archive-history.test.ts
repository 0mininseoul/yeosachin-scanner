import { describe, expect, it } from "vitest";
import { type ArchiveEntry, buildArchiveEntries } from "../../../lib/services/analysis/archive-entries";
import { type OwnerAnalysisHistoryItemV1, ownerAnalysisHistoryV1Schema, ownerHistoryTargetLabel } from "../../../lib/services/analysis/owner-history";
import { ARCHIVE_DELAY_NOTICE_SNOOZE_MS, delayNoticeEnabledFromEnv, encodeDelayNoticeDismissal, hasPendingDelivery, isDelayNoticeSuppressed, shouldShowArchiveDelayNotice } from "../../../lib/services/analysis/archive-delay-notice";
import { type AwaitingEarlybirdDelivery } from "@/lib/services/earlybird/awaiting-delivery";

describe("archive-delay-notice", () => {
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
});

describe("archive-entries", () => {
    function analysisItem(overrides: Partial<OwnerAnalysisHistoryItemV1> = {}): OwnerAnalysisHistoryItemV1 {
        return {
            id: '123e4567-e89b-42d3-a456-426614174000',
            targetInstagramId: 'target.account',
            status: 'completed',
            createdAt: '2026-08-10T09:00:00.000Z',
            planType: 'standard',
            pipelineVersion: 'v2',
            ...overrides,
        };
    }

    function awaitingDelivery(overrides: Partial<AwaitingEarlybirdDelivery> = {}): AwaitingEarlybirdDelivery {
        return {
            orderId: '223e4567-e89b-42d3-a456-426614174000',
            targetInstagramId: 'awaiting.account',
            planId: 'basic',
            createdAt: '2026-08-11T09:00:00.000Z',
            resultRequestId: null,
            ...overrides,
        };
    }

    describe('buildArchiveEntries', () => {
        it('dedupes an awaiting entry whose resultRequestId matches an existing analysis id', () => {
            const analysis = analysisItem({ id: 'analysis-1' });
            const awaiting = awaitingDelivery({ resultRequestId: 'analysis-1' });

            const entries = buildArchiveEntries([analysis], [awaiting]);

            expect(entries).toEqual([{ kind: 'analysis', item: analysis }]);
        });

        it('keeps an awaiting entry whose resultRequestId is null', () => {
            const awaiting = awaitingDelivery({ resultRequestId: null });

            const entries = buildArchiveEntries([], [awaiting]);

            expect(entries).toEqual([{
                kind: 'awaiting_delivery',
                orderId: awaiting.orderId,
                targetInstagramId: awaiting.targetInstagramId,
                planId: awaiting.planId,
                createdAt: awaiting.createdAt,
            }]);
        });

        it('sorts merged entries by createdAt desc', () => {
            const older = analysisItem({ id: 'older', createdAt: '2026-08-09T00:00:00.000Z' });
            const newer = awaitingDelivery({ createdAt: '2026-08-12T00:00:00.000Z', resultRequestId: null });

            const entries = buildArchiveEntries([older], [newer]);

            expect(entries.map((entry) => entry.kind)).toEqual(['awaiting_delivery', 'analysis']);
        });

        it('filters out analysis items with statuses outside pending/processing/completed', () => {
            const failed = {
                ...analysisItem({ id: 'failed-1' }),
                status: 'failed',
            } as unknown as OwnerAnalysisHistoryItemV1;

            const entries = buildArchiveEntries([failed], []);

            expect(entries).toEqual([]);
        });
    });
});

describe("owner-history", () => {
    const completedV2History = {
        schemaVersion: 1,
        items: [{
            id: '123e4567-e89b-42d3-a456-426614174000',
            targetInstagramId: '0_min._.00',
            status: 'completed',
            createdAt: '2026-07-14T05:00:00+00:00',
            planType: 'standard',
            pipelineVersion: 'v2',
        }],
    } as const;

    describe('owner analysis history contract', () => {
        it('accepts the final V2 summary username and renders it as an account', () => {
            const parsed = ownerAnalysisHistoryV1Schema.parse(completedV2History);

            expect(ownerHistoryTargetLabel(parsed.items[0])).toBe('@0_min._.00');
        });

        it('accepts the additive completed V2 public female aggregate', () => {
            const parsed = ownerAnalysisHistoryV1Schema.safeParse({
                ...completedV2History,
                items: [{
                    ...completedV2History.items[0],
                    publicFemaleCount: 7,
                }],
            });

            expect(parsed.success).toBe(true);
            if (parsed.success) {
                expect(parsed.data.items[0]?.publicFemaleCount).toBe(7);
            }
        });

        it('rejects failed requests so they cannot reach owner history rendering', () => {
            const parsed = ownerAnalysisHistoryV1Schema.safeParse({
                ...completedV2History,
                items: [{
                    ...completedV2History.items[0],
                    targetInstagramId: null,
                    status: 'failed',
                }],
            });

            expect(parsed.success).toBe(false);
        });

        it('preserves a legacy V1 username while rejecting a leaked V2 retained tombstone', () => {
            expect(ownerAnalysisHistoryV1Schema.safeParse({
                ...completedV2History,
                items: [{
                    ...completedV2History.items[0],
                    targetInstagramId: 'Legacy.User',
                    pipelineVersion: 'v1',
                }],
            }).success).toBe(true);

            expect(ownerAnalysisHistoryV1Schema.safeParse({
                ...completedV2History,
                items: [{
                    ...completedV2History.items[0],
                    targetInstagramId: 'retained.123e4567e89b42d3a456',
                }],
            }).success).toBe(false);
        });

        it('rejects unversioned, extra-field, and malformed history payloads', () => {
            expect(ownerAnalysisHistoryV1Schema.safeParse(completedV2History.items).success)
                .toBe(false);
            expect(ownerAnalysisHistoryV1Schema.safeParse({
                ...completedV2History,
                extra: true,
            }).success).toBe(false);
            expect(ownerAnalysisHistoryV1Schema.safeParse({
                ...completedV2History,
                items: [{
                    ...completedV2History.items[0],
                    targetInstagramId: '<script>',
                }],
            }).success).toBe(false);
        });
    });
});
