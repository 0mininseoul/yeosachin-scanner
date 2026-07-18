import { describe, expect, it, vi } from 'vitest';
import type {
    ProfileProviderCanaryRunStore,
    StoredProfileProviderCanaryExperiment,
    StoredProfileProviderCanaryRun,
} from '../lib/services/analysis/profile-provider-canary-run-store';
import {
    failedProfileAttempt,
    successfulProfileAttempt,
} from '../lib/services/instagram/providers/profile-attempt';
import type {
    ProfileAttemptResult,
    ProviderCallContext,
} from '../lib/services/instagram/providers/types';
import type { InstagramProfile } from '../lib/types/instagram';
import type { ProfileRepairCanarySourceBundle } from './canary-apify-profile-repair-validation';
import { parseInstagramProfileProviderCanaryArgs } from './canary-instagram-profile-provider-options';
import {
    runInstagramProfileProviderCanary,
    type InstagramProfileProviderCanaryRunRecord,
} from './canary-instagram-profile-provider';
import {
    finalizeProfileProviderCanary,
    parseFinalizeProfileProviderCanaryArgs,
} from './finalize-profile-provider-canary';
import {
    assertProfileProviderCanaryPaidReadiness,
    createFinalizeProfileProviderCanaryRuntimeDependencies,
    createInstagramProfileProviderCanaryRuntimeDependencies,
    orderedProfileProviderCanaryHmac,
    replayProfileProviderCanarySourceBundle,
    type ProfileProviderCanaryRuntimeClient,
} from './profile-provider-canary-runtime';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_EMAIL = 'operator@example.test';
const HMAC_SECRET = Buffer.alloc(32, 17).toString('base64');
const ENV = {
    AUTHORIZED_E2E_OWNER_ID: OWNER_ID,
    AUTHORIZED_E2E_OWNER_EMAIL: OWNER_EMAIL,
    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: HMAC_SECRET,
    PROFILE_PROVIDER_CANARY_ACCOUNT_DEFAULT_ACCESS: 'RESTRICTED',
    PROFILE_PROVIDER_CANARY_ACCOUNT_DEFAULT_ACCESS_VERIFIED_AT:
        '2026-07-19T00:03:00.000Z',
    PROFILE_PROVIDER_CANARY_SHARE_RUN_DATA_WITH_DEVELOPERS: 'DISABLED',
};

function profile(username: string): InstagramProfile {
    return {
        username,
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        isPrivate: false,
        isVerified: false,
    };
}

function incomplete(username: string): ProfileAttemptResult {
    return failedProfileAttempt({
        requestedUsername: username,
        source: 'apify',
        error: new Error('SCRAPING_INCOMPLETE_ERROR'),
        requestCount: 1,
        latencyMs: 1,
        capturedAt: '2026-07-19T00:00:00.000Z',
    });
}

function success(username: string): ProfileAttemptResult {
    return successfulProfileAttempt({
        requestedUsername: username,
        source: 'apify',
        profile: profile(username),
        requestCount: 1,
        latencyMs: 1,
        capturedAt: '2026-07-19T00:00:00.000Z',
    });
}

function sourceFixture() {
    const inputs = new Map<string, string[]>();
    const runs = Array.from({ length: 8 }, (_, index) => {
        const usernames = index === 7
            ? ['critical_0', 'critical_1', 'critical_2', 'critical_success']
            : [`batch_${index}_0`, `batch_${index}_1`];
        const runId = `SourceRun${String(index).padStart(8, '0')}`;
        inputs.set(runId, usernames);
        return {
            jobKey: `track:profiles:batch:${index}`,
            operationKey: `profile-fallback:${index.toString(16).repeat(64)}`,
            status: 'succeeded',
            runId,
            actorId: 'apify/instagram-profile-scraper',
            credentialSlot: 'primary',
            maxChargeUsd: 0.078,
        };
    });
    const bundle: ProfileRepairCanarySourceBundle = {
        request: {
            sourceRequestId: SOURCE_REQUEST_ID,
            userId: OWNER_ID,
            ownerEmail: OWNER_EMAIL,
            targetInstagramId: '0_min._.00',
            pipelineVersion: 'v2',
            status: 'failed',
        },
        runs,
    };
    return { bundle, inputs };
}

function sourceOutcomes(
    usernames: readonly string[],
    context: ProviderCallContext
): ProfileAttemptResult[] {
    if (context.resumeRunId?.endsWith('00000006')) return usernames.map(success);
    if (context.resumeRunId?.endsWith('00000007')) {
        return usernames.map((username, index) => index < 3 ? incomplete(username) : success(username));
    }
    return usernames.map(incomplete);
}

function readyClient(pricingInfos: unknown = [{
    pricingModel: 'PRICE_PER_DATASET_ITEM',
    pricePerUnitUsd: 0.0027,
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
}], tier?: unknown): ProfileProviderCanaryRuntimeClient {
    const accountTier = arguments.length >= 2 ? tier : 'FREE';
    return {
        actor: () => ({
            get: async () => ({
                isPublic: true,
                isDeprecated: false,
                actorPermissionLevel: 'LIMITED_PERMISSIONS',
                taggedBuilds: { latest: { buildNumber: '0.0.692' } },
                pricingInfos,
            }),
        }),
        user: () => ({
            get: async () => ({
                isPaying: true,
                plan: { monthlyUsageCreditsUsd: 5, tier: accountTier },
            }),
            limits: async () => ({
                limits: { maxConcurrentActorJobs: 8, maxMonthlyUsageUsd: 100 },
                current: { activeActorJobCount: 0, monthlyUsageUsd: 0 },
            }),
        }),
    } as unknown as ProfileProviderCanaryRuntimeClient;
}

function tieredResultPricing(
    tieredEventPriceUsd: unknown,
    startedAt = '2026-01-01T00:00:00.000Z'
) {
    return {
        pricingModel: 'PAY_PER_EVENT',
        minimalMaxTotalChargeUsd: 0.0027,
        pricingPerEvent: {
            actorChargeEvents: {
                result: {
                    eventTitle: 'Result',
                    eventDescription: 'A scraped profile result',
                    isPrimaryEvent: true,
                    isOneTimeEvent: false,
                    eventTieredPricingUsd: {
                        FREE: { tieredEventPriceUsd },
                    },
                },
            },
        },
        startedAt: new Date(startedAt),
    };
}

function nextUp(value: number): number {
    const float = new Float64Array([value]);
    const bits = new BigUint64Array(float.buffer);
    bits[0] += BigInt(1);
    return float[0];
}

function clientFixture(
    inputs: Map<string, string[]>,
    snapshot?: Record<string, unknown>,
    resourceAccess: Partial<Record<'kvs' | 'dataset' | 'request_queue', unknown>> = {}
) {
    const starts = vi.fn();
    const storageDeletes = vi.fn();
    const deletedStorage = new Set<string>();
    const inputReads = vi.fn(async (runId: string) => ({
        value: {
            usernames: inputs.get(runId),
            includeAboutSection: false,
        },
    }));
    const storage = (runId: string, kind: 'kvs' | 'dataset' | 'request_queue') => {
        const key = `${runId}:${kind}`;
        const access = Object.prototype.hasOwnProperty.call(resourceAccess, kind)
            ? resourceAccess[kind]
            : 'RESTRICTED';
        return {
            get: vi.fn(async () => deletedStorage.has(key) || access === undefined
                ? undefined
                : { generalAccess: access }),
            delete: vi.fn(async () => {
                storageDeletes(runId, kind);
                deletedStorage.add(key);
            }),
        };
    };
    const client = {
        actor: () => ({ start: starts }),
        dataset: () => ({}),
        user: () => ({ limits: vi.fn() }),
        run: (runId: string) => ({
            get: vi.fn(async () => snapshot),
            waitForFinish: vi.fn(),
            keyValueStore: () => ({
                ...storage(runId, 'kvs'),
                getRecord: () => inputReads(runId),
            }),
            dataset: () => storage(runId, 'dataset'),
            requestQueue: () => storage(runId, 'request_queue'),
        }),
    } as unknown as ProfileProviderCanaryRuntimeClient;
    return { client, starts, storageDeletes, inputReads };
}

describe('profile provider canary runtime source replay', () => {
    it('runs both read-only deployment checks with recovery forced before paid admission', async () => {
        const calls: Array<{ file: string; args: readonly string[]; recovery: string | undefined }> = [];
        const commandRunner = vi.fn(async input => {
            calls.push({
                file: input.file,
                args: input.args,
                recovery: input.env.ANALYSIS_V2_RECOVERY_ENABLED,
            });
        });
        const client = readyClient();

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner,
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).resolves.toBeUndefined();
        expect(calls).toHaveLength(2);
        expect(calls[0]).toMatchObject({
            file: '/bin/bash', recovery: 'true',
        });
        expect(calls[0].args[0]).toMatch(/scripts\/deploy-analysis-v2-worker\.sh$/);
        expect(calls[0].args[1]).toBe('--check');
        expect(calls[1]).toMatchObject({
            file: '/bin/bash', recovery: 'true',
        });
        expect(calls[1].args[0]).toMatch(
            /scripts\/configure-analysis-v2-maintenance\.sh$/
        );
        expect(calls[1].args[1]).toBe('--check');

        const sensitiveFailure = vi.fn(async () => {
            throw new Error('secret stderr with owner and token');
        });
        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner: sensitiveFailure,
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it.each([
        ['a different cheap event', {
            unrelated: {
                eventPriceUsd: 0.001,
                eventTitle: 'Unrelated event',
            },
        }],
        ['a profile-result event whose exact 15-result total exceeds the run cap', {
            'profile-result': {
                eventPriceUsd: 0.004,
                eventTitle: 'Profile result',
            },
        }],
    ])('rejects PAY_PER_EVENT pricing with %s', async (_label, actorChargeEvents) => {
        const commandRunner = vi.fn(async () => undefined);
        const client = readyClient([{
            pricingModel: 'PAY_PER_EVENT',
            minimalMaxTotalChargeUsd: 0.05,
            pricingPerEvent: { actorChargeEvents },
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]);

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner,
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it.each([undefined, '', 'COPPER'])(
        'rejects an unsupported account tier %s',
        async tier => {
            const client = readyClient([tieredResultPricing(0.0027)], tier);

            await expect(assertProfileProviderCanaryPaidReadiness({
                env: ENV,
                client,
                commandRunner: vi.fn(async () => undefined),
                now: () => Date.parse('2026-07-19T00:05:00.000Z'),
            })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
        }
    );

    it.each([0, -0.001, Number.NaN, Number.POSITIVE_INFINITY])(
        'rejects a non-positive or non-finite tier price %s',
        async price => {
            const client = readyClient([tieredResultPricing(price)]);

            await expect(assertProfileProviderCanaryPaidReadiness({
                env: ENV,
                client,
                commandRunner: vi.fn(async () => undefined),
                now: () => Date.parse('2026-07-19T00:05:00.000Z'),
            })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
        }
    );

    it('accepts exactly $0.05 for 15 tiered results and rejects the next representable price', async () => {
        const exactPrice = 0.05 / 15;
        const abovePrice = nextUp(exactPrice);

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client: readyClient([tieredResultPricing(exactPrice)]),
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).resolves.toBeUndefined();
        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client: readyClient([tieredResultPricing(abovePrice)]),
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it('applies the strict exact-15 boundary to dataset-item pricing too', async () => {
        const exactPrice = 0.05 / 15;
        const pricing = (pricePerUnitUsd: number) => ({
            pricingModel: 'PRICE_PER_DATASET_ITEM',
            pricePerUnitUsd,
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client: readyClient([pricing(exactPrice)]),
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).resolves.toBeUndefined();
        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client: readyClient([pricing(nextUp(exactPrice))]),
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it('uses only the latest effective pricing record after a flat-to-tiered transition', async () => {
        const unsafeOldFlat = {
            pricingModel: 'PRICE_PER_DATASET_ITEM',
            pricePerUnitUsd: 0.004,
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        };
        const safeLatestTiered = tieredResultPricing(
            0.0027,
            '2026-06-01T00:00:00.000Z'
        );

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client: readyClient([unsafeOldFlat, safeLatestTiered]),
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).resolves.toBeUndefined();
    });

    it('rejects the latest unsafe tiered record even when an older flat price was safe', async () => {
        const safeOldFlat = {
            pricingModel: 'PRICE_PER_DATASET_ITEM',
            pricePerUnitUsd: 0.0027,
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        };
        const unsafeLatestTiered = tieredResultPricing(
            0.004,
            '2026-06-01T00:00:00.000Z'
        );

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client: readyClient([safeOldFlat, unsafeLatestTiered]),
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it('accepts the exact profile-result PAY_PER_EVENT price within the 15-result cap', async () => {
        const client = readyClient([{
            pricingModel: 'PAY_PER_EVENT',
            minimalMaxTotalChargeUsd: 0.05,
            pricingPerEvent: {
                actorChargeEvents: {
                    'profile-result': {
                        eventPriceUsd: 0.0027,
                        eventTitle: 'Profile result',
                    },
                },
            },
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]);

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).resolves.toBeUndefined();
    });

    it('accepts the live primary result event tier price for the current account tier', async () => {
        const client = readyClient([{
            pricingModel: 'PAY_PER_EVENT',
            minimalMaxTotalChargeUsd: 0.0027,
            pricingPerEvent: {
                actorChargeEvents: {
                    result: {
                        eventTitle: 'Result',
                        eventDescription: 'A scraped profile result',
                        isPrimaryEvent: true,
                        isOneTimeEvent: false,
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.0027 },
                            BRONZE: { tieredEventPriceUsd: 0.0023 },
                            SILVER: { tieredEventPriceUsd: 0.0019 },
                            GOLD: { tieredEventPriceUsd: 0.0015 },
                            PLATINUM: { tieredEventPriceUsd: 0.0009 },
                            DIAMOND: { tieredEventPriceUsd: 0.0005 },
                        },
                    },
                },
            },
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        }], 'FREE');

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).resolves.toBeUndefined();
    });

    it.each([
        ['the current account tier is missing', 'SILVER', {
            FREE: { tieredEventPriceUsd: 0.0027 },
        }],
        ['the current account tier exceeds the exact-15 cap', 'FREE', {
            FREE: { tieredEventPriceUsd: 0.004 },
            BRONZE: { tieredEventPriceUsd: 0.001 },
        }],
        ['the current account tier price is malformed', 'FREE', {
            FREE: { tieredEventPriceUsd: '0.0027' },
        }],
        ['another recognized tier exceeds the exact-15 cap', 'FREE', {
            FREE: { tieredEventPriceUsd: 0.0027 },
            BRONZE: { tieredEventPriceUsd: 0.004 },
        }],
        ['an unknown tier is present', 'FREE', {
            FREE: { tieredEventPriceUsd: 0.0027 },
            UNKNOWN: { tieredEventPriceUsd: 0.001 },
        }],
    ])('rejects tiered result pricing when %s', async (_label, tier, tieredPricing) => {
        const client = readyClient([{
            pricingModel: 'PAY_PER_EVENT',
            minimalMaxTotalChargeUsd: 0.0027,
            pricingPerEvent: {
                actorChargeEvents: {
                    result: {
                        eventTitle: 'Result',
                        eventDescription: 'A scraped profile result',
                        isPrimaryEvent: true,
                        isOneTimeEvent: false,
                        eventTieredPricingUsd: tieredPricing,
                    },
                },
            },
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        }], tier);

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it('rejects an additional charge event beside the tiered result event', async () => {
        const client = readyClient([{
            pricingModel: 'PAY_PER_EVENT',
            minimalMaxTotalChargeUsd: 0.0027,
            pricingPerEvent: {
                actorChargeEvents: {
                    result: {
                        eventTitle: 'Result',
                        eventDescription: 'A scraped profile result',
                        isPrimaryEvent: true,
                        isOneTimeEvent: false,
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.0027 },
                        },
                    },
                    initialization: {
                        eventPriceUsd: 0.001,
                    },
                },
            },
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]);

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it('rejects a result event with both flat and tiered prices', async () => {
        const client = readyClient([{
            pricingModel: 'PAY_PER_EVENT',
            minimalMaxTotalChargeUsd: 0.0027,
            pricingPerEvent: {
                actorChargeEvents: {
                    result: {
                        eventTitle: 'Result',
                        eventDescription: 'A scraped profile result',
                        isPrimaryEvent: true,
                        isOneTimeEvent: false,
                        eventPriceUsd: 0.0027,
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.0027 },
                        },
                    },
                },
            },
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]);

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it.each([
        ['is not primary', { isPrimaryEvent: false, isOneTimeEvent: false }],
        ['omits primary evidence', { isOneTimeEvent: false }],
        ['is one-time', { isPrimaryEvent: true, isOneTimeEvent: true }],
        ['omits one-time evidence', { isPrimaryEvent: true }],
    ])('rejects a tiered result event that %s', async (_label, eventFlags) => {
        const client = readyClient([{
            pricingModel: 'PAY_PER_EVENT',
            minimalMaxTotalChargeUsd: 0.0027,
            pricingPerEvent: {
                actorChargeEvents: {
                    result: {
                        eventTitle: 'Result',
                        eventDescription: 'A scraped profile result',
                        ...eventFlags,
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.0027 },
                        },
                    },
                },
            },
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]);

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it('rejects tiered pricing on a non-result event', async () => {
        const client = readyClient([{
            pricingModel: 'PAY_PER_EVENT',
            minimalMaxTotalChargeUsd: 0.0027,
            pricingPerEvent: {
                actorChargeEvents: {
                    unrelated: {
                        eventTitle: 'Unrelated',
                        eventDescription: 'Not a profile result',
                        isPrimaryEvent: true,
                        eventTieredPricingUsd: {
                            FREE: { tieredEventPriceUsd: 0.001 },
                        },
                    },
                },
            },
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
        }]);

        await expect(assertProfileProviderCanaryPaidReadiness({
            env: ENV,
            client,
            commandRunner: vi.fn(async () => undefined),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
    });

    it.each([
        ['missing', undefined],
        ['too recent for propagation', '2026-07-19T00:04:30.001Z'],
        ['future', '2026-07-19T00:05:00.001Z'],
        ['older than five minutes', '2026-07-18T23:59:59.999Z'],
    ])('rejects a %s manual Restricted-access attestation before deployment checks', async (
        _label,
        verifiedAt
    ) => {
        const commandRunner = vi.fn(async () => undefined);
        await expect(assertProfileProviderCanaryPaidReadiness({
            env: {
                ...ENV,
                PROFILE_PROVIDER_CANARY_ACCOUNT_DEFAULT_ACCESS_VERIFIED_AT: verifiedAt,
            },
            client: readyClient(),
            commandRunner,
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
        expect(commandRunner).not.toHaveBeenCalled();
    });

    it.each(['ENABLED', '', undefined])(
        'rejects share-run-data attestation %s before reserve or start',
        async sharing => {
            const commandRunner = vi.fn(async () => undefined);
            await expect(assertProfileProviderCanaryPaidReadiness({
                env: {
                    ...ENV,
                    PROFILE_PROVIDER_CANARY_SHARE_RUN_DATA_WITH_DEVELOPERS: sharing,
                },
                client: readyClient(),
                commandRunner,
                now: () => Date.parse('2026-07-19T00:05:00.000Z'),
            })).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
            expect(commandRunner).not.toHaveBeenCalled();
        }
    );

    it('computes a domain-separated ordered HMAC and rejects a weak secret', () => {
        const usernames = Array.from({ length: 15 }, (_, index) => `candidate_${index}`);
        const first = orderedProfileProviderCanaryHmac(usernames, ENV);
        const reordered = orderedProfileProviderCanaryHmac(
            [usernames[1], usernames[0], ...usernames.slice(2)], ENV
        );
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(reordered).not.toBe(first);
        expect(() => orderedProfileProviderCanaryHmac(usernames, {
            ...ENV,
            ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET:
                Buffer.alloc(31, 17).toString('base64'),
        })).toThrow('PROFILE_PROVIDER_CANARY_HMAC_CONFIGURATION_INVALID');
    });

    it('replays all eight KVS inputs into the exact ordered public incomplete set', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client, starts, inputReads } = clientFixture(inputs);
        const getOutcomes = vi.fn(async (
            usernames: readonly string[],
            context: ProviderCallContext
        ) => sourceOutcomes(usernames, context));

        const replayed = await replayProfileProviderCanarySourceBundle({
            source: bundle,
            env: ENV,
            clientForSlot: () => client,
            getOutcomes,
        });

        expect(replayed).toMatchObject({
            sourceRunIds: expect.arrayContaining(bundle.runs.map(run => run.runId)),
            usernames: expect.arrayContaining([
                'batch_0_0', 'batch_5_1', 'critical_0', 'critical_1', 'critical_2',
            ]),
            sourceRunCount: 8,
            candidateCount: 15,
            uniqueCandidateCount: 15,
            publicCandidateCount: 15,
            incompleteCandidateCount: 15,
            unavailableCandidateCount: 0,
            primarySuccessCandidateCount: 0,
            criticalCandidateCount: 3,
            criticalIncompleteCount: 3,
        });
        expect(replayed.usernames).toHaveLength(15);
        expect(replayed.criticalUsernames.size).toBe(3);
        expect(inputReads).toHaveBeenCalledTimes(8);
        expect(getOutcomes).toHaveBeenCalledTimes(8);
        expect(starts).not.toHaveBeenCalled();
    });

    it('makes the default replay CLI dependency path read-only and cost-free', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client, starts } = clientFixture(inputs);
        const reserve = vi.fn();
        const store = {
            loadExperiment: vi.fn(async () => null),
            loadSource: vi.fn(async () => bundle),
            reserve,
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store,
            clientForSlot: () => client,
            getSourceProfilesBatchOutcomes: async (usernames, context) =>
                sourceOutcomes(usernames, context),
        });

        await expect(runInstagramProfileProviderCanary(
            parseInstagramProfileProviderCanaryArgs([
                '--source-request-id', SOURCE_REQUEST_ID,
            ]),
            dependencies
        )).resolves.toMatchObject({
            mode: 'replay',
            source_run_count: 8,
            requested_count: 15,
            critical_incomplete_count: 3,
            total_actual_cost_usd: 0,
            session_maximum_exposure_usd: 0,
        });
        expect(reserve).not.toHaveBeenCalled();
        expect(starts).not.toHaveBeenCalled();
    });

    it('checks paid readiness before the first journal reservation', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client, starts } = clientFixture(inputs);
        const reserve = vi.fn();
        const store = {
            loadExperiment: vi.fn(async () => null),
            loadSource: vi.fn(async () => bundle),
            loadRun: vi.fn(async () => null),
            reserve,
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store,
            clientForSlot: () => client,
            getSourceProfilesBatchOutcomes: async (usernames, context) =>
                sourceOutcomes(usernames, context),
            paidReadiness: async () => {
                throw new Error('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
            },
        });

        await expect(runInstagramProfileProviderCanary(
            parseInstagramProfileProviderCanaryArgs([
                '--source-request-id', SOURCE_REQUEST_ID,
                '--confirm-paid-api-call',
            ]),
            dependencies
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
        expect(reserve).not.toHaveBeenCalled();
        expect(starts).not.toHaveBeenCalled();
    });

    it('blocks reserve and Actor start when the privacy attestation is not exact', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client, starts } = clientFixture(inputs);
        const reserve = vi.fn();
        const commandRunner = vi.fn(async () => undefined);
        const store = {
            loadExperiment: vi.fn(async () => null),
            loadSource: vi.fn(async () => bundle),
            loadRun: vi.fn(async () => null),
            reserve,
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: {
                ...ENV,
                PROFILE_PROVIDER_CANARY_SHARE_RUN_DATA_WITH_DEVELOPERS: 'ENABLED',
            },
            store,
            clientForSlot: () => client,
            commandRunner,
            getSourceProfilesBatchOutcomes: async (usernames, context) =>
                sourceOutcomes(usernames, context),
            now: () => Date.parse('2026-07-19T00:05:00.000Z'),
        });

        await expect(runInstagramProfileProviderCanary(
            parseInstagramProfileProviderCanaryArgs([
                '--source-request-id', SOURCE_REQUEST_ID,
                '--confirm-paid-api-call',
            ]),
            dependencies
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_PAID_READINESS_FAILED');
        expect(commandRunner).not.toHaveBeenCalled();
        expect(reserve).not.toHaveBeenCalled();
        expect(starts).not.toHaveBeenCalled();
    });

    it('turns a confirmed terminal provider exception into durable strict failure evidence', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client } = clientFixture(inputs, {
            status: 'FAILED',
            buildNumber: '0.0.692',
            generalAccess: 'RESTRICTED',
        });
        const store = {
            loadExperiment: vi.fn(async () => null),
            loadSource: vi.fn(async () => bundle),
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store,
            clientForSlot: () => client,
            getSourceProfilesBatchOutcomes: async (usernames, context) =>
                sourceOutcomes(usernames, context),
            runReplacement: async input => {
                await input.context?.onRunStarted?.('PaidRun00000001');
                throw new Error('raw provider failure with sensitive payload');
            },
        });
        const replayed = await dependencies.loadSource({ sourceRequestId: SOURCE_REQUEST_ID });

        await expect(dependencies.executeRun({
            usernames: replayed.usernames,
            maximumRunChargeUsd: 0.05,
            onRunStarted: vi.fn(async () => ({
                runStartedAtMs: Date.parse('2026-07-19T00:00:00.000Z'),
            } as InstagramProfileProviderCanaryRunRecord)),
        })).resolves.toMatchObject({
            outcomes: Array.from({ length: 15 }, () => 'other_failure'),
            criticalSuccessCount: 0,
            buildMatched: true,
            restrictedAccess: true,
        });
    });

    it('passes terminal run Restricted-access evidence to durable storage', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client } = clientFixture(inputs);
        const running = {
            sourceRequestId: SOURCE_REQUEST_ID,
            canaryVersion: 'profile-fallback-replacement-canary-v1',
            repetition: 1,
            actorId: 'apify/instagram-scraper',
            actorBuild: '0.0.692',
            inputContractVersion: 1,
            outputContractVersion: 1,
            credentialSlot: 'primary',
            requestedCount: 15,
            maxChargeUsd: 0.05,
            reservationToken: '33333333-3333-4333-8333-333333333333',
            state: 'running',
            runId: 'PaidRun00000001',
            restrictedAccessVerified: true,
            runStartedAt: '2026-07-19T00:00:00.000Z',
            costStatus: 'conservative',
            actualUsageUsd: null,
            kvsCleanupState: 'pending',
            datasetCleanupState: 'pending',
            requestQueueCleanupState: 'pending',
        } as StoredProfileProviderCanaryRun;
        const persisted = {
            ...running,
            state: 'failed',
            terminalCount: 15,
            successCount: 15,
            unavailableCount: 0,
            incompleteCount: 0,
            otherFailureCount: 0,
            criticalSuccessCount: 3,
            latencyMs: 1,
            buildVerified: true,
            restrictedAccessVerified: false,
            gatePassed: false,
        } as unknown as StoredProfileProviderCanaryRun;
        const terminalize = vi.fn(async () => persisted);
        const store = {
            loadSource: vi.fn(async () => bundle),
            loadRun: vi.fn(async () => running),
            terminalize,
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store,
            clientForSlot: () => client,
            getSourceProfilesBatchOutcomes: async (usernames, context) =>
                sourceOutcomes(usernames, context),
        });
        await dependencies.loadSource({ sourceRequestId: SOURCE_REQUEST_ID });

        await dependencies.terminalize({
            repetition: 1,
            runId: 'PaidRun00000001',
            evidence: {
                outcomes: Array.from({ length: 15 }, () => 'success'),
                criticalSuccessCount: 3,
                latencyMs: 1,
                buildMatched: true,
                restrictedAccess: false,
            },
            gatePassed: false,
        });

        expect(terminalize).toHaveBeenCalledWith(expect.objectContaining({
            restrictedAccessVerified: false,
        }));
    });

    it('raises an unreconciled incident for stable observed usage above one dollar', async () => {
        const { inputs } = sourceFixture();
        const { client } = clientFixture(inputs, {
            status: 'SUCCEEDED',
            usageTotalUsd: 1.001,
            finishedAt: '2026-07-19T00:00:00.000Z',
        });
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            clientForSlot: () => client,
            now: () => Date.parse('2026-07-19T00:01:00.000Z'),
            sleep: vi.fn(async () => undefined),
        });

        await expect(dependencies.getStableActualCost('PaidRun00000001'))
            .rejects.toThrow('PROFILE_PROVIDER_CANARY_ACTUAL_COST_OUT_OF_BOUNDS');
    });

    it.each([false, true])(
        'measures a resumed %s run from its durable Actor lifetime',
        async providerFails => {
            const { bundle, inputs } = sourceFixture();
            const { client } = clientFixture(inputs, {
                status: providerFails ? 'FAILED' : 'SUCCEEDED',
                startedAt: '2026-07-19T00:00:00.000Z',
                finishedAt: '2026-07-19T00:02:00.001Z',
                buildNumber: '0.0.692',
                generalAccess: 'RESTRICTED',
            });
            const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
                env: ENV,
                store: {
                    loadSource: vi.fn(async () => bundle),
                } as unknown as ProfileProviderCanaryRunStore,
                clientForSlot: () => client,
                getSourceProfilesBatchOutcomes: async (usernames, context) =>
                    sourceOutcomes(usernames, context),
                runReplacement: async input => {
                    if (providerFails) throw new Error('sensitive terminal failure');
                    return input.usernames.map(success);
                },
                now: () => Date.parse('2026-07-19T00:03:00.000Z'),
            });
            const replayed = await dependencies.loadSource({
                sourceRequestId: SOURCE_REQUEST_ID,
            });

            const result = await dependencies.executeRun({
                usernames: replayed.usernames,
                resumeRunId: 'PaidRun00000001',
                durableRunStartedAtMs: Date.parse('2026-07-19T00:00:00.000Z'),
                maximumRunChargeUsd: 0.05,
                onRunStarted: vi.fn(async () => {
                    throw new Error('resumed run must not checkpoint again');
                }),
            });

            expect(result.latencyMs).toBe(120_001);
            expect(result.latencyMs).toBeGreaterThan(60_000);
        }
    );

    it('uses a fresh run durable checkpoint when the terminal snapshot omits startedAt', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client } = clientFixture(inputs, {
            status: 'SUCCEEDED',
            finishedAt: '2026-07-19T00:02:00.001Z',
            buildNumber: '0.0.692',
            generalAccess: 'RESTRICTED',
        });
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store: {
                loadSource: vi.fn(async () => bundle),
            } as unknown as ProfileProviderCanaryRunStore,
            clientForSlot: () => client,
            getSourceProfilesBatchOutcomes: async (usernames, context) =>
                sourceOutcomes(usernames, context),
            runReplacement: async input => {
                await input.context?.onRunStarted?.('PaidRun00000001');
                return input.usernames.map(success);
            },
        });
        const replayed = await dependencies.loadSource({ sourceRequestId: SOURCE_REQUEST_ID });

        const result = await dependencies.executeRun({
            usernames: replayed.usernames,
            maximumRunChargeUsd: 0.05,
            onRunStarted: vi.fn(async () => ({
                runStartedAtMs: Date.parse('2026-07-19T00:00:00.000Z'),
            } as InstagramProfileProviderCanaryRunRecord)),
        });

        expect(result.latencyMs).toBe(120_001);
    });

    it.each([
        ['missing', { finishedAt: '2026-07-19T00:02:00.000Z' }, undefined],
        ['reversed', {
            startedAt: '2026-07-19T00:03:00.000Z',
            finishedAt: '2026-07-19T00:02:00.000Z',
        }, Date.parse('2026-07-19T00:03:00.000Z')],
    ])('fails closed when terminal Actor timestamps are %s', async (
        _label,
        timestamps,
        durableRunStartedAtMs
    ) => {
        const { bundle, inputs } = sourceFixture();
        const { client } = clientFixture(inputs, {
            status: 'SUCCEEDED',
            ...timestamps,
            buildNumber: '0.0.692',
            generalAccess: 'RESTRICTED',
        });
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store: {
                loadSource: vi.fn(async () => bundle),
            } as unknown as ProfileProviderCanaryRunStore,
            clientForSlot: () => client,
            getSourceProfilesBatchOutcomes: async (usernames, context) =>
                sourceOutcomes(usernames, context),
            runReplacement: async input => input.usernames.map(success),
        });
        const replayed = await dependencies.loadSource({ sourceRequestId: SOURCE_REQUEST_ID });

        const result = await dependencies.executeRun({
            usernames: replayed.usernames,
            resumeRunId: 'PaidRun00000001',
            ...(durableRunStartedAtMs === undefined ? {} : { durableRunStartedAtMs }),
            maximumRunChargeUsd: 0.05,
            onRunStarted: vi.fn(async () => {
                throw new Error('resumed run must not checkpoint again');
            }),
        });

        expect(result.latencyMs).toBe(300_000);
    });

    it.each([
        ['mismatched', { dataset: 'ANYONE' }],
        ['missing', { request_queue: undefined }],
    ])('fails terminal privacy evidence when one storage access is %s', async (
        _label,
        resourceAccess
    ) => {
        const { bundle, inputs } = sourceFixture();
        const { client } = clientFixture(inputs, {
            status: 'SUCCEEDED',
            startedAt: '2026-07-19T00:00:00.000Z',
            finishedAt: '2026-07-19T00:00:01.000Z',
            buildNumber: '0.0.692',
            generalAccess: 'RESTRICTED',
        }, resourceAccess);
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store: {
                loadSource: vi.fn(async () => bundle),
            } as unknown as ProfileProviderCanaryRunStore,
            clientForSlot: () => client,
            getSourceProfilesBatchOutcomes: async (usernames, context) =>
                sourceOutcomes(usernames, context),
            runReplacement: async input => input.usernames.map(success),
        });
        const replayed = await dependencies.loadSource({ sourceRequestId: SOURCE_REQUEST_ID });

        const result = await dependencies.executeRun({
            usernames: replayed.usernames,
            resumeRunId: 'PaidRun00000001',
            durableRunStartedAtMs: Date.parse('2026-07-19T00:00:00.000Z'),
            maximumRunChargeUsd: 0.05,
            onRunStarted: vi.fn(async () => {
                throw new Error('resumed run must not checkpoint again');
            }),
        });

        expect(result.restrictedAccess).toBe(false);
    });

    it('leaves a terminalizing experiment untouched during default replay', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client, starts, storageDeletes } = clientFixture(inputs);
        const markSource = vi.fn();
        const markRun = vi.fn();
        const complete = vi.fn(async () => ({
            state: 'experiment_terminal',
            orderedSetHmac: null,
        } as StoredProfileProviderCanaryExperiment));
        const reserve = vi.fn();
        const loadCleanupInventory = vi.fn(async () => ({
            sourceRequestId: SOURCE_REQUEST_ID,
            sourceRuns: bundle.runs.map(run => ({
                runId: run.runId as string,
                credentialSlot: 'primary' as const,
            })),
            canaryRuns: [],
        }));
        const store = {
            loadExperiment: vi.fn(async () => ({
                state: 'terminalizing',
                cleanupClaimToken: '44444444-4444-4444-8444-444444444444',
            } as StoredProfileProviderCanaryExperiment)),
            loadCleanupInventory,
            markSourceStorageClean: markSource,
            markRunStorageClean: markRun,
            completeExperimentCleanup: complete,
            loadRun: vi.fn(async () => null),
            loadSource: vi.fn(async () => bundle),
            reserve,
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store,
            clientForSlot: () => client,
            getSourceProfilesBatchOutcomes: async (usernames, context) =>
                sourceOutcomes(usernames, context),
        });

        await expect(runInstagramProfileProviderCanary(
            parseInstagramProfileProviderCanaryArgs([
                '--source-request-id', SOURCE_REQUEST_ID,
            ]),
            dependencies
        )).resolves.toMatchObject({
            mode: 'replay',
            source_cleanup_complete: false,
            experiment_terminal: false,
            gate_passed: false,
        });
        expect(loadCleanupInventory).not.toHaveBeenCalled();
        expect(markSource).not.toHaveBeenCalled();
        expect(markRun).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        expect(storageDeletes).not.toHaveBeenCalled();
        expect(reserve).not.toHaveBeenCalled();
        expect(starts).not.toHaveBeenCalled();
    });

    it('resumes partial terminal cleanup before source replay and starts zero Actors', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client, starts } = clientFixture(inputs);
        const storedRun = {
            sourceRequestId: SOURCE_REQUEST_ID,
            canaryVersion: 'profile-fallback-replacement-canary-v1',
            repetition: 1,
            actorId: 'apify/instagram-scraper',
            actorBuild: '0.0.692',
            inputContractVersion: 1,
            outputContractVersion: 1,
            credentialSlot: 'primary',
            requestedCount: 15,
            maxChargeUsd: 0.05,
            reservationToken: '33333333-3333-4333-8333-333333333333',
            state: 'failed',
            runId: 'PaidRun00000001',
            terminalCount: 15,
            successCount: 0,
            unavailableCount: 0,
            incompleteCount: 0,
            otherFailureCount: 15,
            criticalSuccessCount: 0,
            latencyMs: 10,
            buildVerified: true,
            restrictedAccessVerified: true,
            gatePassed: false,
            actualUsageUsd: 0.04,
            costStatus: 'actual',
            kvsCleanupState: 'verified_absent',
            datasetCleanupState: 'verified_absent',
            requestQueueCleanupState: 'verified_absent',
        } as StoredProfileProviderCanaryRun;
        const loadSource = vi.fn();
        const reserve = vi.fn();
        const markSource = vi.fn(async () => ({} as StoredProfileProviderCanaryExperiment));
        const markRun = vi.fn(async () => storedRun);
        const store = {
            loadExperiment: vi.fn(async () => ({
                state: 'terminalizing',
                cleanupClaimToken: '44444444-4444-4444-8444-444444444444',
            } as StoredProfileProviderCanaryExperiment)),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: bundle.runs.map(run => ({
                    runId: run.runId as string,
                    credentialSlot: 'primary' as const,
                })),
                canaryRuns: [{
                    repetition: 1 as const,
                    runId: storedRun.runId as string,
                    credentialSlot: 'primary' as const,
                    reservationToken: storedRun.reservationToken,
                }],
            })),
            markSourceStorageClean: markSource,
            markRunStorageClean: markRun,
            completeExperimentCleanup: vi.fn(async () => ({
                state: 'experiment_terminal',
                orderedSetHmac: null,
            } as StoredProfileProviderCanaryExperiment)),
            loadRun: vi.fn(async ({ repetition }: { repetition: 1 | 2 }) =>
                repetition === 1 ? storedRun : null),
            loadSource,
            reserve,
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createInstagramProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store,
            clientForSlot: () => client,
        });

        await expect(runInstagramProfileProviderCanary(
            parseInstagramProfileProviderCanaryArgs([
                '--source-request-id', SOURCE_REQUEST_ID,
                '--confirm-paid-api-call',
            ]),
            dependencies
        )).resolves.toMatchObject({
            mode: 'paid_canary',
            source_cleanup_complete: true,
            experiment_terminal: true,
            gate_passed: false,
        });
        expect(markSource).toHaveBeenCalledTimes(3);
        expect(markRun).toHaveBeenCalledTimes(3);
        expect(loadSource).not.toHaveBeenCalled();
        expect(reserve).not.toHaveBeenCalled();
        expect(starts).not.toHaveBeenCalled();
    });

    it('wires the cleanup-only finalizer through the claim and HMAC-clearing store path', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client } = clientFixture(inputs);
        const events: string[] = [];
        const storedRun = {
            sourceRequestId: SOURCE_REQUEST_ID,
            canaryVersion: 'profile-fallback-replacement-canary-v1',
            repetition: 1,
            actorId: 'apify/instagram-scraper',
            actorBuild: '0.0.692',
            inputContractVersion: 1,
            outputContractVersion: 1,
            credentialSlot: 'primary',
            requestedCount: 15,
            maxChargeUsd: 0.05,
            reservationToken: '33333333-3333-4333-8333-333333333333',
            state: 'succeeded',
            runId: 'PaidRun00000001',
            actualUsageUsd: 0.04,
            costStatus: 'actual',
            kvsCleanupState: 'verified_absent',
            datasetCleanupState: 'verified_absent',
            requestQueueCleanupState: 'verified_absent',
        } as StoredProfileProviderCanaryRun;
        const store = {
            loadExperiment: vi.fn(async () => null),
            loadSource: vi.fn(async () => bundle),
            loadRun: vi.fn(async ({ repetition }: { repetition: 1 | 2 }) =>
                repetition === 1 ? storedRun : null),
            beginTerminalization: vi.fn(async () => {
                events.push('begin');
                return {
                    cleanupClaimToken: '44444444-4444-4444-8444-444444444444',
                } as StoredProfileProviderCanaryExperiment;
            }),
            markSourceStorageClean: vi.fn(async input => {
                events.push(`source:${input.storage}`);
                return {} as StoredProfileProviderCanaryExperiment;
            }),
            completeExperimentCleanup: vi.fn(async () => {
                events.push('complete');
                return {
                    state: 'experiment_terminal',
                    orderedSetHmac: null,
                } as StoredProfileProviderCanaryExperiment;
            }),
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createFinalizeProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store,
            clientForSlot: () => client,
        });

        await expect(finalizeProfileProviderCanary(
            parseFinalizeProfileProviderCanaryArgs([
                '--source-request-id', SOURCE_REQUEST_ID,
                '--confirm-cleanup-only',
            ]),
            dependencies
        )).resolves.toMatchObject({
            storage_delete_verification_count: 24,
            experiment_status: 'aborted_by_operator',
            actor_start_count: 0,
        });
        expect(events).toEqual([
            'begin',
            'source:kvs',
            'source:dataset',
            'source:request_queue',
            'complete',
        ]);
    });

    it('resumes only pending finalizer cleanup from an active claim without source replay', async () => {
        const { bundle, inputs } = sourceFixture();
        const { client, starts, storageDeletes } = clientFixture(inputs);
        const storedRun = {
            sourceRequestId: SOURCE_REQUEST_ID,
            canaryVersion: 'profile-fallback-replacement-canary-v1',
            repetition: 1,
            actorId: 'apify/instagram-scraper',
            actorBuild: '0.0.692',
            inputContractVersion: 1,
            outputContractVersion: 1,
            credentialSlot: 'primary',
            requestedCount: 15,
            maxChargeUsd: 0.05,
            reservationToken: '33333333-3333-4333-8333-333333333333',
            state: 'failed',
            runId: 'PaidRun00000001',
            actualUsageUsd: 0.04,
            costStatus: 'actual',
            kvsCleanupState: 'verified_absent',
            datasetCleanupState: 'pending',
            requestQueueCleanupState: 'verified_absent',
            restrictedAccessVerified: true,
        } as StoredProfileProviderCanaryRun;
        const loadSource = vi.fn();
        const beginTerminalization = vi.fn();
        const markSourceStorageClean = vi.fn(async () => (
            {} as StoredProfileProviderCanaryExperiment
        ));
        const markRunStorageClean = vi.fn(async () => storedRun);
        const store = {
            loadExperiment: vi.fn(async () => ({
                state: 'terminalizing',
                terminalReason: 'strict_failure',
                cleanupClaimToken: '44444444-4444-4444-8444-444444444444',
                sourceKvsCleanupState: 'verified_absent',
                sourceDatasetCleanupState: 'pending',
                sourceRequestQueueCleanupState: 'pending',
            } as StoredProfileProviderCanaryExperiment)),
            loadCleanupInventory: vi.fn(async () => ({
                sourceRequestId: SOURCE_REQUEST_ID,
                sourceRuns: bundle.runs.map(run => ({
                    runId: run.runId as string,
                    credentialSlot: 'primary' as const,
                })),
                canaryRuns: [{
                    repetition: 1 as const,
                    runId: storedRun.runId as string,
                    credentialSlot: 'primary' as const,
                    reservationToken: storedRun.reservationToken,
                }],
            })),
            loadRun: vi.fn(async ({ repetition }: { repetition: 1 | 2 }) =>
                repetition === 1 ? storedRun : null),
            loadSource,
            beginTerminalization,
            markSourceStorageClean,
            markRunStorageClean,
            completeExperimentCleanup: vi.fn(async () => ({
                state: 'experiment_terminal',
                terminalReason: 'strict_failure',
                orderedSetHmac: null,
            } as StoredProfileProviderCanaryExperiment)),
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createFinalizeProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store,
            clientForSlot: () => client,
        });

        await expect(finalizeProfileProviderCanary(
            parseFinalizeProfileProviderCanaryArgs([
                '--source-request-id', SOURCE_REQUEST_ID,
                '--confirm-cleanup-only',
            ]),
            dependencies
        )).resolves.toMatchObject({
            storage_delete_verification_count: 17,
            experiment_status: 'strict_failure',
            actor_start_count: 0,
        });
        expect(loadSource).not.toHaveBeenCalled();
        expect(beginTerminalization).not.toHaveBeenCalled();
        expect(storageDeletes).toHaveBeenCalledTimes(17);
        expect(markRunStorageClean).toHaveBeenCalledTimes(1);
        expect(markSourceStorageClean).toHaveBeenCalledTimes(2);
        expect(starts).not.toHaveBeenCalled();
    });

    it('returns a terminal finalizer retry without loading source or rewriting cleanup', async () => {
        const { inputs } = sourceFixture();
        const { client, starts, storageDeletes } = clientFixture(inputs);
        const loadSource = vi.fn();
        const beginTerminalization = vi.fn();
        const markSourceStorageClean = vi.fn();
        const markRunStorageClean = vi.fn();
        const store = {
            loadExperiment: vi.fn(async () => ({
                state: 'experiment_terminal',
                terminalReason: 'completed',
                orderedSetHmac: null,
            } as StoredProfileProviderCanaryExperiment)),
            loadRun: vi.fn(async ({ repetition }: { repetition: 1 | 2 }) =>
                repetition === 1 ? ({
                    repetition: 1,
                    runId: 'PaidRun00000001',
                } as StoredProfileProviderCanaryRun) : null),
            loadSource,
            beginTerminalization,
            markSourceStorageClean,
            markRunStorageClean,
        } as unknown as ProfileProviderCanaryRunStore;
        const dependencies = createFinalizeProfileProviderCanaryRuntimeDependencies({
            env: ENV,
            store,
            clientForSlot: () => client,
        });

        await expect(finalizeProfileProviderCanary(
            parseFinalizeProfileProviderCanaryArgs([
                '--source-request-id', SOURCE_REQUEST_ID,
                '--confirm-cleanup-only',
            ]),
            dependencies
        )).resolves.toMatchObject({
            canary_run_count: 1,
            storage_delete_verification_count: 0,
            experiment_status: 'completed',
            actor_start_count: 0,
        });
        expect(loadSource).not.toHaveBeenCalled();
        expect(beginTerminalization).not.toHaveBeenCalled();
        expect(markSourceStorageClean).not.toHaveBeenCalled();
        expect(markRunStorageClean).not.toHaveBeenCalled();
        expect(storageDeletes).not.toHaveBeenCalled();
        expect(starts).not.toHaveBeenCalled();
    });
});
