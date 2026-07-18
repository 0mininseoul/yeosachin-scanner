import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionReplayLocalConfig } from '@amplitude/session-replay-browser/lib/cjs/config/local-config.js';
import { SessionReplayJoinedConfigGenerator } from '@amplitude/session-replay-browser/lib/cjs/config/joined-config.js';
import { SessionReplay } from '@amplitude/session-replay-browser/lib/cjs/session-replay.js';

const amplitudeMocks = vi.hoisted(() => ({
    getUserId: vi.fn(),
    initAll: vi.fn(),
    moduleLoads: 0,
    reset: vi.fn(),
    setUserId: vi.fn(),
    track: vi.fn(),
}));

vi.mock('@amplitude/unified', () => {
    amplitudeMocks.moduleLoads += 1;
    return amplitudeMocks;
});

const API_KEY = '0123456789abcdef0123456789abcdef';
const VALID_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const SECOND_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

async function loadAnalytics() {
    return import('./analytics');
}

function enableBrowser(apiKey = API_KEY) {
    vi.stubGlobal('window', {});
    vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', apiKey);
}

describe('Amplitude analytics adapter', () => {
    beforeEach(() => {
        vi.resetModules();
        amplitudeMocks.getUserId.mockReset().mockReturnValue(VALID_USER_ID);
        amplitudeMocks.initAll.mockReset();
        amplitudeMocks.initAll.mockResolvedValue(undefined);
        amplitudeMocks.moduleLoads = 0;
        amplitudeMocks.reset.mockReset();
        amplitudeMocks.setUserId.mockReset();
        amplitudeMocks.track.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('exports only canonical approved events with no legacy aliases', async () => {
        const { EVENTS } = await loadAnalytics();

        expect(EVENTS).toEqual({
            LANDING_VIEWED: 'landing_viewed',
            TARGET_SUBMITTED: 'target_submitted',
            AUTH_STARTED: 'auth_started',
            AUTH_COMPLETED: 'auth_completed',
            PREFLIGHT_STARTED: 'preflight_started',
            PREFLIGHT_SUCCEEDED: 'preflight_succeeded',
            PREFLIGHT_FAILED: 'preflight_failed',
            EXCLUSION_DECIDED: 'exclusion_decided',
            PLAN_VIEWED: 'plan_viewed',
            PLAN_SELECTED: 'plan_selected',
            CHECKOUT_STARTED: 'checkout_started',
            CHECKOUT_REDIRECTED: 'checkout_redirected',
            PAYMENT_CONFIRMED_VIEWED: 'payment_confirmed_viewed',
            EARLYBIRD_STATUS_VIEWED: 'earlybird_status_viewed',
            ANALYSIS_STARTED: 'analysis_started',
            ANALYSIS_COMPLETED: 'analysis_completed',
            RESULT_VIEWED: 'result_viewed',
            RESULT_SHARED: 'result_shared',
        });
        expect((EVENTS as Record<string, string>).CLICK_CTA_START).toBeUndefined();
        expect((EVENTS as Record<string, string>).VIEW_RESULT).toBeUndefined();
        expect((EVENTS as Record<string, string>).CLICK_SHARE_KAKAO).toBeUndefined();
    });

    it('rotates stored identity on first anonymous boot with one safe initialization', async () => {
        enableBrowser();
        const hostileFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            configs: {
                sessionReplay: {
                    sr_interaction_config: { enabled: true, batch: true },
                    sr_logging_config: {
                        console: { enabled: true, levels: ['log'] },
                        network: {
                            enabled: true,
                            body: { request: true, response: true },
                        },
                    },
                    sr_privacy_config: {
                        defaultMaskLevel: 'light',
                        unmaskSelector: ['*'],
                        urlMaskLevels: [{ match: '*', maskLevel: 'light' }],
                    },
                    sr_targeting_config: { variants: {} },
                },
            },
        })));
        vi.stubGlobal('fetch', hostileFetch);
        const { initAmplitude } = await loadAnalytics();

        const [firstResult, secondResult] = await Promise.all([
            initAmplitude(null),
            initAmplitude(null),
        ]);

        expect(firstResult).toBe(true);
        expect(secondResult).toBe(true);
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.getUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId).not.toHaveBeenCalled();
        expect(amplitudeMocks.initAll.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.getUserId.mock.invocationCallOrder[0]);
        expect(amplitudeMocks.getUserId.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.reset.mock.invocationCallOrder[0]);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                handleFetchConfig: (request: unknown) => Promise<Response>;
            };
        };
        expect(options).toEqual({
            analytics: {
                autocapture: {
                    sessions: false,
                    attribution: false,
                    pageViews: false,
                    formInteractions: false,
                    fileDownloads: false,
                    elementInteractions: false,
                    frustrationInteractions: false,
                    pageUrlEnrichment: false,
                    networkTracking: false,
                    webVitals: false,
                    performanceTracking: false,
                },
                fetchRemoteConfig: false,
                remoteConfig: { fetchRemoteConfig: false },
            },
            sessionReplay: {
                sampleRate: 0,
                privacyConfig: {
                    defaultMaskLevel: 'conservative',
                    maskSelector: ['.amp-mask', '[data-amp-mask]'],
                    blockSelector: ['.amp-block', '[data-amp-block]'],
                },
                interactionConfig: { enabled: false, batch: false },
                performanceConfig: { enabled: false },
                captureDocumentTitle: false,
                enableUrlChangePolling: false,
                handleFetchConfig: expect.any(Function),
            },
            engagement: { skip: true },
        });

        const response = await options.sessionReplay.handleFetchConfig({
            url: 'https://hostile.example/config',
            method: 'GET',
            headers: { authorization: 'secret' },
        });
        const config = await response.json();
        expect(config).toEqual({
            configs: {
                sessionReplay: {
                    sr_sampling_config: {
                        sample_rate: 0,
                        capture_enabled: false,
                    },
                },
            },
        });
        const serialized = JSON.stringify(config);
        for (const forbidden of [
            'sr_privacy_config',
            'sr_logging_config',
            'sr_interaction_config',
            'sr_targeting_config',
            'urlMaskLevels',
            'unmask',
            'console',
            'network',
            'body',
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(hostileFetch).not.toHaveBeenCalled();
    });

    it('resets a different stored user before applying the first authenticated user', async () => {
        enableBrowser();
        const { initAmplitude } = await loadAnalytics();

        await expect(initAmplitude(SECOND_UUID)).resolves.toBe(true);

        expect(amplitudeMocks.getUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([[SECOND_UUID]]);
        expect(amplitudeMocks.initAll.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.getUserId.mock.invocationCallOrder[0]);
        expect(amplitudeMocks.getUserId.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.reset.mock.invocationCallOrder[0]);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.setUserId.mock.invocationCallOrder[0]);
    });

    it('resets an absent stored user before applying the first authenticated user', async () => {
        enableBrowser();
        amplitudeMocks.getUserId.mockReturnValue(undefined);
        const { initAmplitude } = await loadAnalytics();

        await expect(initAmplitude(SECOND_UUID)).resolves.toBe(true);

        expect(amplitudeMocks.getUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([[SECOND_UUID]]);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.setUserId.mock.invocationCallOrder[0]);
    });

    it('preserves an exactly matching stored user on first authenticated boot', async () => {
        enableBrowser();
        amplitudeMocks.getUserId.mockReturnValue(SECOND_UUID);
        const { initAmplitude } = await loadAnalytics();

        await expect(initAmplitude(SECOND_UUID)).resolves.toBe(true);

        expect(amplitudeMocks.getUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
        expect(amplitudeMocks.setUserId).not.toHaveBeenCalled();
    });

    it('fails closed to reset when the stored user cannot be read', async () => {
        enableBrowser();
        amplitudeMocks.getUserId.mockImplementationOnce(() => {
            throw new Error('identity unavailable');
        });
        const { initAmplitude } = await loadAnalytics();

        await expect(initAmplitude(SECOND_UUID)).resolves.toBe(true);

        expect(amplitudeMocks.getUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([[SECOND_UUID]]);
    });

    it('preserves only current-revision events across a failed boot reset retry', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        amplitudeMocks.reset.mockImplementationOnce(() => {
            throw new Error('reset failed');
        });
        const analytics = await loadAnalytics();

        const firstUserInitialization = analytics.initAmplitude(VALID_USER_ID);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));
        analytics.trackEvent(analytics.EVENTS.ANALYSIS_STARTED, {
            request_id: VALID_USER_ID,
            plan_id: 'standard',
        });
        const nextUserInitialization = analytics.initAmplitude(SECOND_UUID);
        analytics.trackEvent(analytics.EVENTS.ANALYSIS_STARTED, {
            request_id: SECOND_UUID,
            plan_id: 'basic',
        });
        resolveInitialization();
        await expect(firstUserInitialization).resolves.toBe(false);
        await expect(nextUserInitialization).resolves.toBe(false);

        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'authenticated' });
        await expect(analytics.initAmplitude(SECOND_UUID)).resolves.toBe(true);
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.getUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(2);
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([
            [undefined],
            [SECOND_UUID],
        ]);
        expect(amplitudeMocks.initAll.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.getUserId.mock.invocationCallOrder[0]);
        expect(amplitudeMocks.getUserId.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.reset.mock.invocationCallOrder[0]);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.reset.mock.invocationCallOrder[1]);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[1])
            .toBeLessThan(amplitudeMocks.setUserId.mock.invocationCallOrder[1]);
        expect(amplitudeMocks.track.mock.calls).toEqual([[
            'analysis_started',
            { request_id: SECOND_UUID, plan_id: 'basic' },
        ]]);
        expect(JSON.stringify(amplitudeMocks.track.mock.calls)).not.toContain(VALID_USER_ID);
    });

    it('fails closed after the installed SDK joins deterministic replay remote config', async () => {
        const shareToken = 'a'.repeat(64);
        const requestId = '11111111-1111-4111-8111-111111111111';
        const preflightId = '22222222-2222-4222-8222-222222222222';
        const sensitiveUrl = `https://yeosachin.vercel.app/share/${shareToken}`
            + `?preflight=${preflightId}#result/${requestId}`;
        enableBrowser();
        vi.stubGlobal('location', { href: sensitiveUrl });
        const { initAmplitude } = await loadAnalytics();

        await initAmplitude(null);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                sampleRate: number;
                interactionConfig: {
                    enabled: boolean;
                    batch: boolean;
                };
                handleFetchConfig: (request: unknown) => Promise<Response>;
                handleSendEvents?: unknown;
            };
        };
        expect(options.sessionReplay).toMatchObject({
            sampleRate: 0,
            interactionConfig: { enabled: false, batch: false },
        });
        expect(options.sessionReplay.handleSendEvents).toBeUndefined();

        const deterministicResponse = await options.sessionReplay.handleFetchConfig({
            url: 'https://hostile.example/config',
            method: 'GET',
            headers: { authorization: 'secret' },
        });
        const deterministicConfig = await deterministicResponse.json() as {
            configs: { sessionReplay: Record<string, unknown> };
        };
        const remoteClient = {
            subscribe: vi.fn((
                _key: string | undefined,
                _deliveryMode: unknown,
                callback: (
                    config: Record<string, unknown>,
                    source: 'remote',
                    lastFetch: Date,
                ) => void,
            ) => {
                callback(deterministicConfig.configs.sessionReplay, 'remote', new Date());
                return 'safe-config-subscription';
            }),
            unsubscribe: vi.fn(() => true),
            updateConfigs: vi.fn(),
        };
        const localConfig = new SessionReplayLocalConfig(
            API_KEY,
            options.sessionReplay as never,
        );
        expect(localConfig.sampleRate).toBe(0);
        const generator = new SessionReplayJoinedConfigGenerator(
            remoteClient as never,
            localConfig,
        );

        const { joinedConfig, remoteConfig } = await generator.generateJoinedConfig();

        expect(remoteConfig?.sr_sampling_config).toEqual({
            sample_rate: 0,
            capture_enabled: false,
        });
        expect(joinedConfig.captureEnabled).toBe(false);
        expect(joinedConfig.sampleRate).toBe(0);
        expect(joinedConfig.interactionConfig?.enabled).not.toBe(true);

        const replay = new SessionReplay();
        replay.config = joinedConfig;
        replay.identifiers = {
            sessionId: 1_721_234_567_890,
            deviceId: 'test-device',
        };
        expect(replay.getShouldRecord()).toBe(false);
        expect(JSON.stringify({
            currentUrl: sensitiveUrl,
            shouldRecord: replay.getShouldRecord(),
        })).toContain('"shouldRecord":false');
    });

    it('does not load or initialize Unified from a child event before auth resolves', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();

        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, {
            stage: 'authenticated',
        });
        await Promise.resolve();

        expect(amplitudeMocks.moduleLoads).toBe(0);
        expect(amplitudeMocks.initAll).not.toHaveBeenCalled();
        expect(amplitudeMocks.track).not.toHaveBeenCalled();
    });

    it('never loads Unified on the server or with a missing key', async () => {
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', API_KEY);
        const serverAnalytics = await loadAnalytics();

        await expect(serverAnalytics.initAmplitude(null)).resolves.toBe(false);
        expect(amplitudeMocks.moduleLoads).toBe(0);

        vi.resetModules();
        vi.stubGlobal('window', {});
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', '');
        const missingKeyAnalytics = await loadAnalytics();

        await expect(missingKeyAnalytics.initAmplitude(null)).resolves.toBe(false);
        expect(amplitudeMocks.moduleLoads).toBe(0);
        expect(amplitudeMocks.initAll).not.toHaveBeenCalled();
    });

    it.each([
        '   ',
        'xxx',
        'test-key',
        '00000000000000000000000000000000',
        '0123456789abcdef0123456789abcdeg',
        '0123456789abcdef0123456789abcdef00',
    ])('rejects malformed or placeholder API key %j before loading the SDK', async (apiKey) => {
        enableBrowser(apiKey);
        const { initAmplitude } = await loadAnalytics();

        await expect(initAmplitude(null)).resolves.toBe(false);
        expect(amplitudeMocks.moduleLoads).toBe(0);
        expect(amplitudeMocks.initAll).not.toHaveBeenCalled();
    });

    it('clears a rejected initialization latch so a later call can retry', async () => {
        enableBrowser();
        amplitudeMocks.initAll
            .mockRejectedValueOnce(new Error('sdk unavailable'))
            .mockResolvedValueOnce(undefined);
        const { initAmplitude } = await loadAnalytics();

        await expect(initAmplitude(VALID_USER_ID)).resolves.toBe(false);
        await expect(initAmplitude(VALID_USER_ID)).resolves.toBe(true);

        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(2);
        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
    });

    it('queues every genuine duplicate action until explicit init and identity readiness', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const analytics = await loadAnalytics();

        const initialization = analytics.initAmplitude(null);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });

        analytics.markAnalyticsIdentityReady();
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        resolveInitialization();
        await initialization;
        await vi.waitFor(() => expect(amplitudeMocks.track).toHaveBeenCalledTimes(2));
        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['target_submitted', { stage: 'anonymous' }],
            ['target_submitted', { stage: 'anonymous' }],
        ]);
    });

    it('preserves a landing event queued before the first anonymous identity resolves', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, { source: 'direct' });

        await analytics.initAmplitude(null);
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.track.mock.calls).toEqual([[
            'landing_viewed',
            { source: 'direct' },
        ]]);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.track.mock.invocationCallOrder[0]);
    });

    it('preserves pre-resolution events through the first anonymous reset boundary', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const analytics = await loadAnalytics();
        analytics.trackEvent(analytics.EVENTS.ANALYSIS_STARTED, {
            request_id: VALID_USER_ID,
            plan_id: 'standard',
        });

        const initialization = analytics.initAmplitude(null);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });
        resolveInitialization();
        await initialization;
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.track.mock.calls).toEqual([
            [
                'analysis_started',
                { request_id: VALID_USER_ID, plan_id: 'standard' },
            ],
            ['target_submitted', { stage: 'anonymous' }],
        ]);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.track.mock.invocationCallOrder[0]);
    });

    it('bounds the pending current-identity queue to the latest 50 validated invocations', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const analytics = await loadAnalytics();
        const initialization = analytics.initAmplitude(null);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));

        for (let resultCount = 0; resultCount < 55; resultCount += 1) {
            analytics.trackEvent(analytics.EVENTS.RESULT_VIEWED, {
                request_id: VALID_USER_ID,
                result_count: resultCount,
                is_shared: false,
            });
        }

        resolveInitialization();
        await initialization;
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.track).toHaveBeenCalledTimes(50);
        expect(amplitudeMocks.track.mock.calls[0]).toEqual(['result_viewed', {
            request_id: VALID_USER_ID,
            result_count: 5,
            is_shared: false,
        }]);
        expect(amplitudeMocks.track.mock.calls.at(-1)).toEqual(['result_viewed', {
            request_id: VALID_USER_ID,
            result_count: 54,
            is_shared: false,
        }]);
    });

    it('does not retain events when the API key is invalid', async () => {
        enableBrowser('xxx');
        const analytics = await loadAnalytics();

        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, { source: 'direct' });
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', API_KEY);
        await analytics.initAmplitude(null);
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.track).not.toHaveBeenCalled();
    });

    it('drops authenticated events queued before logout resolves during initialization', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const analytics = await loadAnalytics();

        const authenticatedInit = analytics.initAmplitude(VALID_USER_ID);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));
        analytics.trackEvent(analytics.EVENTS.PAYMENT_CONFIRMED_VIEWED, {
            order_id: VALID_USER_ID,
            plan_id: 'basic',
            amount_krw: 14_900,
            status: 'paid',
        });
        const anonymousInit = analytics.initAmplitude(null);
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });

        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
        expect(amplitudeMocks.setUserId).not.toHaveBeenCalled();

        resolveInitialization();
        await Promise.all([authenticatedInit, anonymousInit]);
        expect(amplitudeMocks.getUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId).not.toHaveBeenCalled();
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        analytics.markAnalyticsIdentityReady();
        expect(amplitudeMocks.track.mock.calls).toEqual([[
            'target_submitted',
            { stage: 'anonymous' },
        ]]);
        expect(JSON.stringify(amplitudeMocks.track.mock.calls)).not.toContain(VALID_USER_ID);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.track.mock.invocationCallOrder[0]);
    });

    it('drops the old user event but preserves the new user event across an in-flight reset', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const analytics = await loadAnalytics();

        const firstUserInit = analytics.initAmplitude(VALID_USER_ID);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));
        analytics.trackEvent(analytics.EVENTS.ANALYSIS_STARTED, {
            request_id: VALID_USER_ID,
            plan_id: 'basic',
        });
        const nextUserInit = analytics.initAmplitude(SECOND_UUID);
        analytics.trackEvent(analytics.EVENTS.ANALYSIS_STARTED, {
            request_id: SECOND_UUID,
            plan_id: 'standard',
        });

        resolveInitialization();
        await Promise.all([firstUserInit, nextUserInit]);
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.track.mock.calls).toEqual([[
            'analysis_started',
            { request_id: SECOND_UUID, plan_id: 'standard' },
        ]]);
        expect(JSON.stringify(amplitudeMocks.track.mock.calls)).not.toContain(VALID_USER_ID);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.setUserId.mock.invocationCallOrder[0]);
        expect(amplitudeMocks.setUserId.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.track.mock.invocationCallOrder[0]);
    });

    it('resets before applying the latest user when identity changes while SDK import waits', async () => {
        enableBrowser();
        let resolveModuleLoad!: () => void;
        const moduleLoadPromise = new Promise<void>((resolve) => {
            resolveModuleLoad = resolve;
        });
        vi.doMock('@amplitude/unified', async () => {
            amplitudeMocks.moduleLoads += 1;
            await moduleLoadPromise;
            return amplitudeMocks;
        });
        const analytics = await loadAnalytics();

        const firstUserInit = analytics.initAmplitude(VALID_USER_ID);
        await vi.waitFor(() => expect(amplitudeMocks.moduleLoads).toBe(1));
        const anonymousInit = analytics.initAmplitude(null);
        const nextUserInit = analytics.initAmplitude(SECOND_UUID);

        expect(amplitudeMocks.initAll).not.toHaveBeenCalled();
        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
        expect(amplitudeMocks.setUserId).not.toHaveBeenCalled();

        resolveModuleLoad();
        await Promise.all([firstUserInit, anonymousInit, nextUserInit]);

        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.getUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([[SECOND_UUID]]);
        expect(amplitudeMocks.initAll.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.getUserId.mock.invocationCallOrder[0]);
        expect(amplitudeMocks.getUserId.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.reset.mock.invocationCallOrder[0]);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.setUserId.mock.invocationCallOrder[0]);
    });

    it('applies an event-specific property schema', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(null);
        analytics.markAnalyticsIdentityReady();

        analytics.trackEvent(analytics.EVENTS.AUTH_STARTED, {
            provider: 'kakao',
            source: 'direct',
            request_id: VALID_USER_ID,
        });
        analytics.trackEvent(analytics.EVENTS.RESULT_VIEWED, {
            request_id: VALID_USER_ID,
            result_count: 8,
            is_shared: false,
            provider: 'kakao',
            share_channel: 'clipboard',
            token: 'secret',
        });
        analytics.trackEvent(analytics.EVENTS.RESULT_SHARED, {
            request_id: SECOND_UUID,
            share_channel: 'web_share',
            result_count: 8,
        });

        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['auth_started', { provider: 'kakao' }],
            ['result_viewed', {
                request_id: VALID_USER_ID,
                result_count: 8,
                is_shared: false,
            }],
            ['result_shared', {
                request_id: SECOND_UUID,
                share_channel: 'web_share',
            }],
        ]);
    });

    it.each([
        'private_handle',
        'PRIVATE_HANDLE',
        '01012345678',
        'person@example.com',
        'https://example.com/private',
    ])('rejects adversarial string %j under every string property catalog', async (value) => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(null);
        analytics.markAnalyticsIdentityReady();

        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, {
            source: value,
            medium: value,
            campaign: value,
            content: value,
            term: value,
        });
        analytics.trackEvent(analytics.EVENTS.AUTH_STARTED, { provider: value });
        analytics.trackEvent(analytics.EVENTS.PREFLIGHT_SUCCEEDED, {
            required_plan_id: value,
            followers_bucket: value,
            following_bucket: value,
            preflight_id: value,
        });
        analytics.trackEvent(analytics.EVENTS.PREFLIGHT_FAILED, {
            error_code: value,
            stage: value,
            preflight_id: value,
        });
        analytics.trackEvent(analytics.EVENTS.EXCLUSION_DECIDED, {
            preflight_id: value,
            decision: value,
        });
        analytics.trackEvent(analytics.EVENTS.PAYMENT_CONFIRMED_VIEWED, {
            order_id: value,
            plan_id: value,
            status: value,
        });
        analytics.trackEvent(analytics.EVENTS.RESULT_SHARED, {
            request_id: value,
            share_channel: value,
        });

        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['landing_viewed', {}],
            ['auth_started', {}],
            ['preflight_succeeded', {}],
            ['preflight_failed', { error_code: 'UNKNOWN' }],
            ['exclusion_decided', {}],
            ['payment_confirmed_viewed', {}],
            ['result_shared', {}],
        ]);
        expect(JSON.stringify(amplitudeMocks.track.mock.calls)).not.toContain(value);
    });

    it('accepts only registered product and lifecycle values', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(null);
        analytics.markAnalyticsIdentityReady();

        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, {
            source: 'google',
            medium: 'paid_social',
            campaign: 'launch_2026',
            content: 'hero-a',
            term: 'detector',
        });
        analytics.trackEvent(analytics.EVENTS.PREFLIGHT_FAILED, {
            duration_ms: 12_500,
            error_code: 'NETWORK_ERROR',
            stage: 'preflight',
            preflight_id: VALID_USER_ID,
        });
        analytics.trackEvent(analytics.EVENTS.PAYMENT_CONFIRMED_VIEWED, {
            order_id: SECOND_UUID,
            plan_id: 'basic',
            amount_krw: 14_900,
            status: 'paid',
        });

        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['landing_viewed', {
                source: 'google',
                medium: 'paid_social',
                campaign: 'launch_2026',
                content: 'hero-a',
                term: 'detector',
            }],
            ['preflight_failed', {
                duration_ms: 12_500,
                error_code: 'NETWORK_ERROR',
                stage: 'preflight',
                preflight_id: VALID_USER_ID,
            }],
            ['payment_confirmed_viewed', {
                order_id: SECOND_UUID,
                plan_id: 'basic',
                amount_krw: 14_900,
                status: 'paid',
            }],
        ]);
    });

    it('ignores unapproved events and contains tracking errors', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(VALID_USER_ID);
        analytics.markAnalyticsIdentityReady();

        analytics.trackEvent('legacy_event' as never, { source: 'direct' });
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        amplitudeMocks.track.mockImplementationOnce(() => {
            throw new Error('tracking failed');
        });
        expect(() => analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED)).not.toThrow();
    });

    it('resets once on initialized logout and holds queued events until identity is ready', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();

        await analytics.initAmplitude(VALID_USER_ID);
        analytics.markAnalyticsIdentityReady();
        amplitudeMocks.setUserId.mockClear();

        await analytics.initAmplitude(null);
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });

        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId).not.toHaveBeenCalled();
        expect(amplitudeMocks.track).not.toHaveBeenCalled();
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);

        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.track).toHaveBeenCalledWith('target_submitted', {
            stage: 'anonymous',
        });
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.track.mock.invocationCallOrder[0]);
    });

    it('does not reset for repeated resolved anonymous identity', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();

        await analytics.initAmplitude(null);
        await analytics.initAmplitude(null);

        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId).not.toHaveBeenCalled();
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
    });

    it('resets before changing directly between authenticated users', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(VALID_USER_ID);
        amplitudeMocks.reset.mockClear();
        amplitudeMocks.setUserId.mockClear();

        await expect(analytics.initAmplitude(SECOND_UUID)).resolves.toBe(true);

        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([[SECOND_UUID]]);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.setUserId.mock.invocationCallOrder[0]);
    });

    it('retains the reconciled anonymous device and its queued events when the user authenticates', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(null);
        amplitudeMocks.reset.mockClear();
        analytics.markAnalyticsIdentityPending();
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });

        await expect(analytics.initAmplitude(SECOND_UUID)).resolves.toBe(true);
        analytics.trackEvent(analytics.EVENTS.ANALYSIS_STARTED, {
            request_id: SECOND_UUID,
            plan_id: 'basic',
        });
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([[SECOND_UUID]]);
        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['target_submitted', { stage: 'anonymous' }],
            ['analysis_started', { request_id: SECOND_UUID, plan_id: 'basic' }],
        ]);
    });

    it('contains reset failure, attempts to clear user ID, and keeps delivery closed', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(VALID_USER_ID);
        analytics.markAnalyticsIdentityReady();
        amplitudeMocks.setUserId.mockClear();
        amplitudeMocks.reset.mockImplementationOnce(() => {
            throw new Error('reset failed');
        });
        amplitudeMocks.setUserId.mockImplementationOnce(() => {
            throw new Error('fallback failed');
        });

        await expect(analytics.initAmplitude(null)).resolves.toBe(false);
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId).toHaveBeenCalledWith(undefined);
        expect(amplitudeMocks.track).not.toHaveBeenCalled();
    });

    it('retries a failed logout reset on the next repeated anonymous initialization', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(VALID_USER_ID);
        analytics.markAnalyticsIdentityReady();
        amplitudeMocks.setUserId.mockClear();
        amplitudeMocks.reset.mockImplementationOnce(() => {
            throw new Error('reset failed');
        });

        await expect(analytics.initAmplitude(null)).resolves.toBe(false);
        await expect(analytics.initAmplitude(null)).resolves.toBe(true);
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });

        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(2);
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([[undefined]]);
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.reset.mock.invocationCallOrder[1]);
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        analytics.markAnalyticsIdentityReady();
        expect(amplitudeMocks.track).toHaveBeenCalledWith('target_submitted', {
            stage: 'anonymous',
        });
    });

    it('retries a failed logout reset before applying the next authenticated user', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(VALID_USER_ID);
        analytics.markAnalyticsIdentityReady();
        amplitudeMocks.setUserId.mockClear();
        amplitudeMocks.reset.mockImplementationOnce(() => {
            throw new Error('reset failed');
        });

        await expect(analytics.initAmplitude(null)).resolves.toBe(false);
        await expect(analytics.initAmplitude(SECOND_UUID)).resolves.toBe(true);
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'authenticated' });

        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(2);
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([
            [undefined],
            [SECOND_UUID],
        ]);
        expect(amplitudeMocks.reset.mock.invocationCallOrder[1])
            .toBeLessThan(amplitudeMocks.setUserId.mock.invocationCallOrder[1]);
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        analytics.markAnalyticsIdentityReady();
        expect(amplitudeMocks.track).toHaveBeenCalledWith('target_submitted', {
            stage: 'authenticated',
        });
    });

    it('sets the next authenticated user after a successful logout reset', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();

        await analytics.initAmplitude(VALID_USER_ID);
        await analytics.initAmplitude(null);
        await analytics.initAmplitude(SECOND_UUID);
        await analytics.initAmplitude('person@example.com' as never);

        expect(amplitudeMocks.setUserId.mock.calls).toEqual([
            [SECOND_UUID],
        ]);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
    });

    it('contains no static Unified SDK import', () => {
        const source = readFileSync(new URL('./analytics.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/import\s+(?:\*|\{)[\s\S]*?from\s+['"]@amplitude\/unified['"]/);
        expect(source).toContain("import('@amplitude/unified')");
    });
});
