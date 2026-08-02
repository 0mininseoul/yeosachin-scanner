import { describe, expect, it, vi } from 'vitest';
import {
    BETA_APIFY_CREDIT_INPUT_ERROR,
    BETA_APIFY_CREDIT_READ_ERROR,
    BETA_APIFY_CREDIT_REFRESH_ERROR,
    BETA_APIFY_FREE_CREDENTIAL_SLOTS,
    calculateBetaApifyEffectiveHeadroom,
    isBetaApifyFreeCredentialSlot,
    readBetaApifyAccountCredit,
    refreshBetaApifyCreditPool,
    type ApifyUserCreditClient,
    type BetaApifyFreeCredentialSlot,
} from './beta-apify-credit-pool';

const CYCLE_START = '2026-08-01T00:00:00.000Z';
const CYCLE_END = '2026-09-01T00:00:00.000Z';
const OBSERVED_AT = new Date('2026-08-02T01:02:03.000Z');
const MAX_OBSERVED_AT_FUTURE_SKEW_MS = 60_000;
const TEST_CLOCK = Object.freeze({ now: () => OBSERVED_AT.getTime() });

function rawLimits(
    monthlyLimitUsd: unknown = 10,
    startAt: unknown = new Date(CYCLE_START),
    endAt: unknown = new Date(CYCLE_END),
    currentMonthlyUsageUsd: unknown = 2
): unknown {
    return {
        id: 'provider-account-id-must-not-escape',
        token: 'apify-secret-token-must-not-escape',
        monthlyUsageCycle: { startAt, endAt },
        limits: { maxMonthlyUsageUsd: monthlyLimitUsd },
        current: { monthlyUsageUsd: currentMonthlyUsageUsd },
    };
}

function rawMonthlyUsage(
    monthlyUsageUsd: unknown = 2,
    startAt: unknown = CYCLE_START,
    endAt: unknown = CYCLE_END
): unknown {
    return {
        userId: 'provider-account-id-must-not-escape',
        apiToken: 'apify-secret-token-must-not-escape',
        usageCycle: { startAt, endAt },
        totalUsageCreditsUsdAfterVolumeDiscount: monthlyUsageUsd,
        monthlyServiceUsage: { ACTOR_COMPUTE: { amountAfterVolumeDiscountUsd: 2 } },
    };
}

function clientWith(
    limits: unknown = rawLimits(),
    monthlyUsage: unknown = rawMonthlyUsage()
): ApifyUserCreditClient {
    return {
        limits: vi.fn().mockResolvedValue(limits),
        monthlyUsage: vi.fn().mockResolvedValue(monthlyUsage),
    };
}

function betaSlotAmounts(value: number): Record<BetaApifyFreeCredentialSlot, number> {
    return Object.fromEntries(
        BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(slot => [slot, value])
    ) as Record<BetaApifyFreeCredentialSlot, number>;
}

describe('beta Apify credit pool primitives', () => {
    it('defines one immutable exact free-slot subset that structurally excludes secondary', () => {
        expect(BETA_APIFY_FREE_CREDENTIAL_SLOTS).toEqual([
            'primary',
            'tertiary',
            'quaternary',
            'quinary',
            'senary',
            'septenary',
        ]);
        expect(Object.isFrozen(BETA_APIFY_FREE_CREDENTIAL_SLOTS)).toBe(true);

        for (const slot of BETA_APIFY_FREE_CREDENTIAL_SLOTS) {
            expect(isBetaApifyFreeCredentialSlot(slot)).toBe(true);
        }
        for (const rejected of ['secondary', 'unknown', '', null, undefined]) {
            expect(isBetaApifyFreeCredentialSlot(rejected)).toBe(false);
        }
    });

    it('normalizes only the required safe limit, usage, cycle, and observation fields', async () => {
        const client = clientWith();

        const reading = await readBetaApifyAccountCredit({
            credentialSlot: 'primary',
            client,
            observedAt: OBSERVED_AT,
        }, TEST_CLOCK);

        expect(reading).toEqual({
            credentialSlot: 'primary',
            monthlyLimitUsd: 10,
            monthlyUsageUsd: 2,
            billingCycleStartAt: CYCLE_START,
            billingCycleEndAt: CYCLE_END,
            observedAt: OBSERVED_AT.toISOString(),
        });
        expect(client.limits).toHaveBeenCalledOnce();
        expect(client.monthlyUsage).toHaveBeenCalledOnce();
        expect(JSON.stringify(reading)).not.toMatch(
            /provider-account-id|apify-secret-token|userId|apiToken/
        );
    });

    it.each([
        ['limits current usage is higher', 4.5, 2, 4.5],
        ['detailed monthly usage is higher', 1, 2.5, 2.5],
    ])('uses the conservative usage when %s', async (
        _name,
        limitsCurrentUsageUsd,
        detailedMonthlyUsageUsd,
        expectedUsageUsd
    ) => {
        const reading = await readBetaApifyAccountCredit({
            credentialSlot: 'primary',
            client: clientWith(
                rawLimits(
                    10,
                    new Date(CYCLE_START),
                    new Date(CYCLE_END),
                    limitsCurrentUsageUsd
                ),
                rawMonthlyUsage(detailedMonthlyUsageUsd)
            ),
            observedAt: OBSERVED_AT,
        }, TEST_CLOCK);

        expect(reading.monthlyUsageUsd).toBe(expectedUsageUsd);
    });

    it('rounds provider credit values to the database precision without increasing headroom', async () => {
        const reading = await readBetaApifyAccountCredit({
            credentialSlot: 'primary',
            client: clientWith(
                rawLimits(
                    7.123456789012987,
                    new Date(CYCLE_START),
                    new Date(CYCLE_END),
                    1.000000000000001
                ),
                rawMonthlyUsage(1.000000000000002)
            ),
            observedAt: OBSERVED_AT,
        }, TEST_CLOCK);

        expect(reading.monthlyLimitUsd).toBe(7.123456789012);
        expect(reading.monthlyUsageUsd).toBe(1.000000000001);
        expect(calculateBetaApifyEffectiveHeadroom({
            monthlyLimitUsd: reading.monthlyLimitUsd,
            monthlyUsageUsd: reading.monthlyUsageUsd,
            activeReservationsUsd: 0,
            localPostSnapshotDebitUsd: 0,
        })).toBe(6.123456789011);
    });

    it('returns conservative database-safe credit snapshots from a pool refresh', async () => {
        const readings = await refreshBetaApifyCreditPool({
            clientForSlot: () => clientWith(
                rawLimits(
                    7.123456789012987,
                    new Date(CYCLE_START),
                    new Date(CYCLE_END),
                    1.000000000000001
                ),
                rawMonthlyUsage(1.000000000000002)
            ),
            observedAt: OBSERVED_AT,
        }, TEST_CLOCK);

        expect(readings).toHaveLength(BETA_APIFY_FREE_CREDENTIAL_SLOTS.length);
        for (const reading of readings) {
            expect(reading.monthlyLimitUsd).toBe(7.123456789012);
            expect(reading.monthlyUsageUsd).toBe(1.000000000001);
            expect(reading.effectiveHeadroomUsd).toBe(6.123456789011);
        }
    });

    it.each([
        ['negative limit', rawLimits(-0.01), rawMonthlyUsage()],
        ['infinite limit', rawLimits(Number.POSITIVE_INFINITY), rawMonthlyUsage()],
        ['non-numeric limit', rawLimits('10'), rawMonthlyUsage()],
        ['negative usage', rawLimits(), rawMonthlyUsage(-0.01)],
        ['NaN usage', rawLimits(), rawMonthlyUsage(Number.NaN)],
        ['non-numeric usage', rawLimits(), rawMonthlyUsage('2')],
        [
            'negative limits current usage',
            rawLimits(10, CYCLE_START, CYCLE_END, -0.01),
            rawMonthlyUsage(),
        ],
        [
            'infinite limits current usage',
            rawLimits(10, CYCLE_START, CYCLE_END, Number.POSITIVE_INFINITY),
            rawMonthlyUsage(),
        ],
        [
            'non-numeric limits current usage',
            rawLimits(10, CYCLE_START, CYCLE_END, '2'),
            rawMonthlyUsage(),
        ],
        ['invalid cycle start', rawLimits(10, 'not-a-date'), rawMonthlyUsage()],
        [
            'reversed cycle',
            rawLimits(10, CYCLE_END, CYCLE_START),
            rawMonthlyUsage(2, CYCLE_END, CYCLE_START),
        ],
        [
            'inconsistent endpoint cycles',
            rawLimits(),
            rawMonthlyUsage(2, '2026-07-01T00:00:00.000Z', CYCLE_END),
        ],
    ])('fails closed for %s', async (_name, limits, monthlyUsage) => {
        await expect(readBetaApifyAccountCredit({
            credentialSlot: 'tertiary',
            client: clientWith(limits, monthlyUsage),
            observedAt: OBSERVED_AT,
        }, TEST_CLOCK)).rejects.toEqual(new Error(BETA_APIFY_CREDIT_READ_ERROR));
    });

    it.each([
        [
            'an expired cycle',
            '2026-07-01T00:00:00.000Z',
            '2026-08-02T01:02:02.999Z',
        ],
        [
            'a future cycle',
            '2026-08-02T01:02:03.001Z',
            CYCLE_END,
        ],
        [
            'the exact cycle rollover instant',
            CYCLE_START,
            OBSERVED_AT.toISOString(),
        ],
    ])('rejects matching provider responses for %s', async (
        _name,
        cycleStart,
        cycleEnd
    ) => {
        await expect(readBetaApifyAccountCredit({
            credentialSlot: 'primary',
            client: clientWith(
                rawLimits(10, cycleStart, cycleEnd),
                rawMonthlyUsage(2, cycleStart, cycleEnd)
            ),
            observedAt: OBSERVED_AT,
        }, TEST_CLOCK)).rejects.toEqual(new Error(BETA_APIFY_CREDIT_READ_ERROR));
    });

    it('rejects an observation beyond trusted clock skew before provider I/O starts', async () => {
        const client = clientWith();
        const futureObservedAt = new Date(
            OBSERVED_AT.getTime() + MAX_OBSERVED_AT_FUTURE_SKEW_MS + 1
        );

        await expect(readBetaApifyAccountCredit({
            credentialSlot: 'primary',
            client,
            observedAt: futureObservedAt,
        }, TEST_CLOCK)).rejects.toEqual(new Error(BETA_APIFY_CREDIT_READ_ERROR));
        expect(client.limits).not.toHaveBeenCalled();
        expect(client.monthlyUsage).not.toHaveBeenCalled();
    });

    it('subtracts active reservations and local post-snapshot debit without going negative', () => {
        expect(calculateBetaApifyEffectiveHeadroom({
            monthlyLimitUsd: 10,
            monthlyUsageUsd: 2,
            activeReservationsUsd: 1.25,
            localPostSnapshotDebitUsd: 0.75,
        })).toBe(6);
        expect(calculateBetaApifyEffectiveHeadroom({
            monthlyLimitUsd: 10,
            monthlyUsageUsd: 8,
            activeReservationsUsd: 3,
            localPostSnapshotDebitUsd: 4,
        })).toBe(0);
    });

    it.each([
        ['monthlyLimitUsd', Number.NaN],
        ['monthlyUsageUsd', -1],
        ['activeReservationsUsd', Number.POSITIVE_INFINITY],
        ['localPostSnapshotDebitUsd', -0.01],
    ] as const)('rejects an invalid %s headroom input', (field, value) => {
        expect(() => calculateBetaApifyEffectiveHeadroom({
            monthlyLimitUsd: 10,
            monthlyUsageUsd: 2,
            activeReservationsUsd: 1,
            localPostSnapshotDebitUsd: 0.5,
            [field]: value,
        })).toThrow(BETA_APIFY_CREDIT_INPUT_ERROR);
    });

    it('starts all six account reads concurrently and returns only sanitized credit state', async () => {
        let releaseReads: (() => void) | undefined;
        const readGate = new Promise<void>(resolve => {
            releaseReads = resolve;
        });
        const started: string[] = [];
        const clientForSlot = vi.fn((slot: BetaApifyFreeCredentialSlot) => ({
            limits: vi.fn(async () => {
                started.push(`limits:${slot}`);
                await readGate;
                return rawLimits();
            }),
            monthlyUsage: vi.fn(async () => {
                started.push(`monthlyUsage:${slot}`);
                await readGate;
                return rawMonthlyUsage();
            }),
        }));

        const pending = refreshBetaApifyCreditPool({
            clientForSlot,
            activeReservationsUsdBySlot: betaSlotAmounts(1),
            localPostSnapshotDebitUsdBySlot: betaSlotAmounts(0.5),
            observedAt: OBSERVED_AT,
        }, TEST_CLOCK);

        await vi.waitFor(() => expect(started).toHaveLength(12));
        expect(clientForSlot.mock.calls.map(([slot]) => slot)).toEqual(
            BETA_APIFY_FREE_CREDENTIAL_SLOTS
        );
        releaseReads?.();

        const readings = await pending;
        expect(readings).toEqual(BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(
            credentialSlot => ({
                credentialSlot,
                monthlyLimitUsd: 10,
                monthlyUsageUsd: 2,
                billingCycleStartAt: CYCLE_START,
                billingCycleEndAt: CYCLE_END,
                observedAt: OBSERVED_AT.toISOString(),
                activeReservationsUsd: 1,
                localPostSnapshotDebitUsd: 0.5,
                effectiveHeadroomUsd: 6.5,
            })
        ));
        expect(JSON.stringify(readings)).not.toMatch(
            /provider-account-id|apify-secret-token|userId|apiToken/
        );
    });

    it('uses immutable pre-call reservation and debit snapshots during deferred reads', async () => {
        let releaseReads: (() => void) | undefined;
        const readGate = new Promise<void>(resolve => {
            releaseReads = resolve;
        });
        const started: string[] = [];
        const activeReservationsUsdBySlot = betaSlotAmounts(3);
        const localPostSnapshotDebitUsdBySlot = betaSlotAmounts(2);
        const clientForSlot = vi.fn((slot: BetaApifyFreeCredentialSlot) => ({
            limits: vi.fn(async () => {
                started.push(`limits:${slot}`);
                await readGate;
                return rawLimits();
            }),
            monthlyUsage: vi.fn(async () => {
                started.push(`monthlyUsage:${slot}`);
                await readGate;
                return rawMonthlyUsage();
            }),
        }));

        const pending = refreshBetaApifyCreditPool({
            clientForSlot,
            activeReservationsUsdBySlot,
            localPostSnapshotDebitUsdBySlot,
            observedAt: OBSERVED_AT,
        }, TEST_CLOCK);

        await vi.waitFor(() => expect(started).toHaveLength(12));
        for (const slot of BETA_APIFY_FREE_CREDENTIAL_SLOTS) {
            activeReservationsUsdBySlot[slot] = 0;
            localPostSnapshotDebitUsdBySlot[slot] = 0;
        }
        releaseReads?.();

        const readings = await pending;
        for (const reading of readings) {
            expect(reading).toMatchObject({
                activeReservationsUsd: 3,
                localPostSnapshotDebitUsd: 2,
                effectiveHeadroomUsd: 3,
            });
        }
    });

    it('validates every slot amount before creating a provider client', async () => {
        const activeReservationsUsdBySlot = betaSlotAmounts(1);
        activeReservationsUsdBySlot.primary = Number.NaN;
        const clientForSlot = vi.fn(() => clientWith());

        await expect(refreshBetaApifyCreditPool({
            clientForSlot,
            activeReservationsUsdBySlot,
            observedAt: OBSERVED_AT,
        }, TEST_CLOCK)).rejects.toEqual(new Error(BETA_APIFY_CREDIT_REFRESH_ERROR));
        expect(clientForSlot).not.toHaveBeenCalled();
    });

    it.each(['rejected provider call', 'invalid provider response'])(
        'fails the entire six-slot refresh closed for a %s',
        async failureKind => {
            const clientForSlot = vi.fn((slot: BetaApifyFreeCredentialSlot) => {
                if (slot !== 'quinary') return clientWith();
                if (failureKind === 'rejected provider call') {
                    return {
                        limits: vi.fn().mockRejectedValue(
                            new Error('apify-secret-token-must-not-escape')
                        ),
                        monthlyUsage: vi.fn().mockResolvedValue(rawMonthlyUsage()),
                    };
                }
                return clientWith(rawLimits(-1), rawMonthlyUsage());
            });

            const error = await refreshBetaApifyCreditPool({
                clientForSlot,
                observedAt: OBSERVED_AT,
            }, TEST_CLOCK).then(
                () => undefined,
                reason => reason
            );

            expect(error).toEqual(new Error(BETA_APIFY_CREDIT_REFRESH_ERROR));
            expect(String(error)).not.toMatch(/apify-secret-token|provider-account-id/);
            expect(clientForSlot.mock.calls.map(([slot]) => slot)).toEqual(
                BETA_APIFY_FREE_CREDENTIAL_SLOTS
            );
        }
    );
});
