import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, RemoteConfigClient } from '@amplitude/analytics-core';
import { SessionReplayPlugin } from '@amplitude/plugin-session-replay-browser';
import { SessionReplayLocalConfig } from '@amplitude/session-replay-browser/lib/cjs/config/local-config.js';
import { SessionReplayJoinedConfigGenerator } from '@amplitude/session-replay-browser/lib/cjs/config/joined-config.js';
import { SessionReplay } from '@amplitude/session-replay-browser/lib/cjs/session-replay.js';

const amplitudeMocks = vi.hoisted(() => ({
    getUserId: vi.fn(),
    initAll: vi.fn(),
    moduleLoads: 0,
    reset: vi.fn(),
    sessionReplay: vi.fn(),
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

async function loadReplayAnalytics(demoAnalysisEnabled = false) {
    const analytics = await loadAnalytics();
    analytics.updateAmplitudeReplayRuntimeContext({ demoAnalysisEnabled });
    return analytics;
}

function enableBrowser(apiKey = API_KEY) {
    vi.stubGlobal('window', {});
    vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', apiKey);
}

function enableReplayBrowser({
    doNotTrack,
    globalPrivacyControl,
    hash = '',
    pathname = '/',
    search = '',
}: {
    doNotTrack?: string;
    globalPrivacyControl?: boolean;
    hash?: string;
    pathname?: string;
    search?: string;
} = {}) {
    const eventTarget = new EventTarget();
    const location = {
        hash,
        href: `https://yeosachin.vercel.app${pathname}${search}${hash}`,
        origin: 'https://yeosachin.vercel.app',
        pathname,
        search,
    };
    const applyUrl = (value: string | URL | null | undefined) => {
        if (value === null || value === undefined) return;
        const next = new URL(String(value), location.href);
        location.hash = next.hash;
        location.href = next.href;
        location.pathname = next.pathname;
        location.search = next.search;
    };
    vi.stubGlobal('window', {
        addEventListener: eventTarget.addEventListener.bind(eventTarget),
        dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
        history: {
            pushState: (_data: unknown, _unused: string, url?: string | URL | null) => applyUrl(url),
            replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => applyUrl(url),
        },
        location,
        navigator: { doNotTrack, globalPrivacyControl },
        removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    });
    vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', API_KEY);
    vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE', '0.1');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'production');
}

describe('Amplitude analytics adapter', () => {
    beforeEach(() => {
        vi.resetModules();
        amplitudeMocks.getUserId.mockReset().mockReturnValue(VALID_USER_ID);
        amplitudeMocks.initAll.mockReset();
        amplitudeMocks.initAll.mockResolvedValue(undefined);
        amplitudeMocks.moduleLoads = 0;
        amplitudeMocks.reset.mockReset();
        amplitudeMocks.sessionReplay.mockReset().mockReturnValue({ shutdown: vi.fn() });
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
            ANALYSIS_DURATION_ESTIMATE_SHOWN: 'analysis_duration_estimate_shown',
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
                        maskSelector: [
                            '.amp-mask',
                            '[data-amp-mask]',
                            'form',
                            'input',
                            'textarea',
                            'select',
                            'option',
                            '[contenteditable]',
                        ],
                        blockSelector: [
                            '.amp-block',
                            '[data-amp-block]',
                            '[data-amp-sensitive]',
                            '[data-amp-private]',
                            'img',
                            'video',
                            'audio',
                            'canvas',
                            'svg',
                        ],
                    },
                    interactionConfig: { enabled: false, batch: false },
                    performanceConfig: { enabled: false },
                    captureDocumentTitle: false,
                    enableUrlChangePolling: false,
                    shouldInlineStylesheet: false,
                    captureAdoptedStyleSheets: false,
                    crossOriginIframes: { enabled: false },
                    storeType: 'memory',
                    handleFetchConfig: expect.any(Function),
                    handleSendEvents: expect.any(Function),
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
                handleSendEvents: (request: unknown) => Promise<Response>;
            };
        };
        expect(options.sessionReplay).toMatchObject({
            sampleRate: 0,
            interactionConfig: { enabled: false, batch: false },
        });
        expect(options.sessionReplay.handleSendEvents).toEqual(expect.any(Function));

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

    it('enables only the explicit bounded production sample after an exact remote acknowledgement', async () => {
        enableReplayBrowser();
        const hostileRemoteConfig = {
            configs: {
                sessionReplay: {
                    sr_sampling_config: { capture_enabled: true, sample_rate: 0.1 },
                    sr_interaction_config: { enabled: true, batch: true },
                    sr_logging_config: {
                        console: { enabled: true },
                        network: { enabled: true, body: { request: true, response: true } },
                    },
                    sr_privacy_config: { unmaskSelector: ['*'] },
                },
            },
        };
        const configFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(hostileRemoteConfig)));
        vi.stubGlobal('fetch', configFetch);
        const { initAmplitude } = await loadReplayAnalytics();

        await expect(initAmplitude(null)).resolves.toBe(true);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                sampleRate: number;
                handleFetchConfig: (request: {
                    headers: Record<string, string>;
                    method: 'GET';
                    url: string;
                }) => Promise<Response>;
            };
        };
        expect(options.sessionReplay.sampleRate).toBe(0.1);
        const response = await options.sessionReplay.handleFetchConfig({
            headers: { accept: 'application/json' },
            method: 'GET',
            url: `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser`,
        });
        expect(configFetch).toHaveBeenCalledWith(
            `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser`,
            expect.objectContaining({
                method: 'GET',
                headers: { Accept: '*/*' },
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
            }),
        );
        expect(await response.json()).toEqual({
            configs: {
                sessionReplay: {
                    sr_sampling_config: { capture_enabled: true, sample_rate: 0.1 },
                },
            },
        });
    });

    it('normalizes the canonical 0.10 production sample to numeric 0.1', async () => {
        enableReplayBrowser();
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE', '0.10');
        const { initAmplitude } = await loadReplayAnalytics();

        await initAmplitude(null);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as { sessionReplay: { sampleRate: number } };
        expect(options.sessionReplay.sampleRate).toBe(0.1);
    });

    it('accepts the exact URL generated by the installed Amplitude remote config client', async () => {
        enableReplayBrowser();
        const configFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            configs: {
                sessionReplay: {
                    sr_sampling_config: { capture_enabled: true, sample_rate: 0.1 },
                },
            },
        })));
        vi.stubGlobal('fetch', configFetch);
        const { initAmplitude } = await loadReplayAnalytics();
        await initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { handleFetchConfig: (request: { headers: Record<string, string>; method: 'GET'; signal?: AbortSignal; url: string }) => Promise<Response> };
        };
        const client = new RemoteConfigClient(
            API_KEY,
            new Logger(),
            'US',
            undefined,
            options.sessionReplay.handleFetchConfig,
        );
        const generatedUrl = (client as unknown as { getUrlParams: () => string }).getUrlParams();

        expect(generatedUrl).toBe(`https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser`);
        const response = await options.sessionReplay.handleFetchConfig({
            headers: { Accept: '*/*' },
            method: 'GET',
            url: generatedUrl,
        });
        expect((await response.json()).configs.sessionReplay.sr_sampling_config).toEqual({
            capture_enabled: true,
            sample_rate: 0.1,
        });
    });

    it.each(['', 'preview', 'development'])('never enables replay without the exact public production discriminator %j', async (publicEnvironment) => {
        enableReplayBrowser();
        vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', publicEnvironment);
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('VERCEL_ENV', 'production');
        const { initAmplitude } = await loadReplayAnalytics();

        await initAmplitude(null);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as { sessionReplay: { sampleRate: number } };
        expect(options.sessionReplay.sampleRate).toBe(0);
    });

    it.each([
        ['development', 'true', '0.1', undefined, undefined],
        ['production', 'false', '0.1', undefined, undefined],
        ['production', 'true', '0', undefined, undefined],
        ['production', 'true', '0.11', undefined, undefined],
        ['production', 'true', '0.1', '1', undefined],
        ['production', 'true', '0.1', undefined, true],
    ] as const)('fails replay closed for env/privacy boundary %s/%s/%s', async (
        nodeEnv,
        enabled,
        sampleRate,
        doNotTrack,
        globalPrivacyControl,
    ) => {
        enableReplayBrowser({ doNotTrack, globalPrivacyControl });
        vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', nodeEnv);
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED', enabled);
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE', sampleRate);
        const { initAmplitude } = await loadReplayAnalytics();

        await expect(initAmplitude(null)).resolves.toBe(true);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as { sessionReplay: { sampleRate: number } };
        expect(options.sessionReplay.sampleRate).toBe(0);
    });

    it('fails replay closed for demo, query, fragment, and sensitive routes without changing funnel delivery', async () => {
        enableReplayBrowser({ pathname: '/result/request-id' });
        const analytics = await loadReplayAnalytics(true);

        await expect(analytics.initAmplitude(null)).resolves.toBe(true);
        analytics.markAnalyticsIdentityReady();
        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, { source: 'direct' });
        const options = amplitudeMocks.initAll.mock.calls[0][1] as { sessionReplay: { sampleRate: number } };
        expect(options.sessionReplay.sampleRate).toBe(0);
        expect(amplitudeMocks.track).toHaveBeenCalledWith('landing_viewed', { source: 'direct' });
    });

    it('does not accept unavailable, malformed, or wrong-sample remote replay config', async () => {
        enableReplayBrowser();
        const configFetch = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(new Response(JSON.stringify({ configs: { sessionReplay: {} } })))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                configs: {
                    sessionReplay: { sr_sampling_config: { capture_enabled: true, sample_rate: 0.01 } },
                },
            })));
        vi.stubGlobal('fetch', configFetch);
        const { initAmplitude } = await loadReplayAnalytics();
        await initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { handleFetchConfig: (request: { headers: Record<string, string>; method: 'GET'; url: string }) => Promise<Response> };
        };

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const response = await options.sessionReplay.handleFetchConfig({
                headers: { Accept: '*/*' },
                method: 'GET',
                url: `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser`,
            });
            expect(await response.json()).toEqual({
                configs: {
                    sessionReplay: {
                        sr_sampling_config: { capture_enabled: false, sample_rate: 0 },
                    },
                },
            });
        }
        const untrusted = await options.sessionReplay.handleFetchConfig({
            headers: {}, method: 'GET', url: 'https://attacker.invalid/config',
        });
        expect((await untrusted.json()).configs.sessionReplay.sr_sampling_config.capture_enabled).toBe(false);
        expect(configFetch).toHaveBeenCalledTimes(3);
    });

    it.each([
        `https://sr-client-cfg.amplitude.com:443/config/${API_KEY}?config_group=browser`,
        `https://user@sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser`,
        `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser&extra=1`,
        `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser#fragment`,
        `https://sr-client-cfg.amplitude.com/config/${SECOND_UUID}?config_group=browser`,
        `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser&config_group=browser`,
    ])('rejects non-canonical replay config URL %s without a network request', async (url) => {
        enableReplayBrowser();
        const configFetch = vi.fn();
        vi.stubGlobal('fetch', configFetch);
        const { initAmplitude } = await loadReplayAnalytics();
        await initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { handleFetchConfig: (request: { headers: Record<string, string>; method: 'GET'; url: string }) => Promise<Response> };
        };

        const response = await options.sessionReplay.handleFetchConfig({
            headers: { Accept: '*/*', Authorization: 'must-not-forward' },
            method: 'GET',
            url,
        });

        expect((await response.json()).configs.sessionReplay.sr_sampling_config.capture_enabled).toBe(false);
        expect(configFetch).not.toHaveBeenCalled();
    });

    it('rejects a redirected replay config response even when its body looks valid', async () => {
        enableReplayBrowser();
        const redirectedResponse = new Response(JSON.stringify({
            configs: {
                sessionReplay: {
                    sr_sampling_config: { capture_enabled: true, sample_rate: 0.1 },
                },
            },
        }));
        Object.defineProperty(redirectedResponse, 'redirected', { value: true });
        const configFetch = vi.fn().mockResolvedValue(redirectedResponse);
        vi.stubGlobal('fetch', configFetch);
        const { initAmplitude } = await loadReplayAnalytics();
        await initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { handleFetchConfig: (request: { headers: Record<string, string>; method: 'GET'; url: string }) => Promise<Response> };
        };

        const response = await options.sessionReplay.handleFetchConfig({
            headers: { Accept: '*/*' },
            method: 'GET',
            url: `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser`,
        });

        expect((await response.json()).configs.sessionReplay.sr_sampling_config.capture_enabled).toBe(false);
        expect(configFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
        }));
    });

    it('stops replay exactly once when a route becomes sensitive and on teardown', async () => {
        enableReplayBrowser();
        const shutdown = vi.fn();
        amplitudeMocks.sessionReplay.mockReturnValue({ shutdown });
        const analytics = await loadReplayAnalytics();
        await analytics.initAmplitude(null);

        const location = (window as unknown as { location: { pathname: string; search: string; hash: string } }).location;
        location.pathname = '/analyze';
        analytics.enforceAmplitudeReplayRoutePrivacy();
        analytics.enforceAmplitudeReplayRoutePrivacy();
        analytics.teardownAmplitudeSessionReplay();

        expect(shutdown).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
    });

    it('drops a replay upload when the current location gains a query or hash', async () => {
        enableReplayBrowser();
        const replayFetch = vi.fn();
        vi.stubGlobal('fetch', replayFetch);
        const analytics = await loadReplayAnalytics();
        await analytics.initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                handleSendEvents: (request: {
                    body: string;
                    headers: Record<string, string>;
                    keepalive: boolean;
                    method: 'POST';
                    url: string;
                }) => Promise<Response>;
            };
        };
        const location = window.location as unknown as { hash: string; href: string };
        location.hash = '#token';
        location.href = 'https://yeosachin.vercel.app/#token';

        const response = await options.sessionReplay.handleSendEvents({
            body: 'safe-route-replay-payload',
            headers: { Authorization: `Bearer ${API_KEY}`, 'X-Client-Url': location.href },
            keepalive: true,
            method: 'POST',
            url: 'https://api-sr.amplitude.com/sessions/v2/track?device_id=device&session_id=1721234567890&type=replay',
        });

        expect(response.status).toBe(204);
        expect(replayFetch).not.toHaveBeenCalled();
    });

    it('uploads a safe-route replay with only the fixed transport metadata', async () => {
        enableReplayBrowser();
        const replayFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', replayFetch);
        const analytics = await loadReplayAnalytics();
        await analytics.initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                handleSendEvents: (request: {
                    body: string;
                    headers: Record<string, string>;
                    keepalive: boolean;
                    method: 'POST';
                    url: string;
                }) => Promise<Response>;
            };
        };
        const url = 'https://api-sr.amplitude.com/sessions/v2/track?device_id=device&session_id=1721234567890&type=replay';

        const response = await options.sessionReplay.handleSendEvents({
            body: 'safe-route-replay-payload',
            headers: {
                Accept: '*/*',
                Authorization: `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'X-Client-Library': 'plugin/1.33.4',
                'X-Client-Sample-Rate': '0.1',
                'X-Client-Url': 'https://yeosachin.vercel.app/',
                'X-Client-Version': '1.33.4',
                'X-Sampling-Hash-Alg': 'xxhash32',
                Cookie: 'must-not-forward',
            },
            keepalive: true,
            method: 'POST',
            url,
        });

        expect(response.status).toBe(200);
        expect(replayFetch).toHaveBeenCalledWith(url, {
            method: 'POST',
            headers: {
                Accept: '*/*',
                Authorization: `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'X-Client-Library': 'plugin/1.33.4',
                'X-Client-Sample-Rate': '0.1',
                'X-Client-Version': '1.33.4',
                'X-Sampling-Hash-Alg': 'xxhash32',
            },
            body: 'safe-route-replay-payload',
            keepalive: true,
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
        });
        expect(JSON.stringify(replayFetch.mock.calls)).not.toContain('X-Client-Url');
        expect(JSON.stringify(replayFetch.mock.calls)).not.toContain('Cookie');
    });

    it.each([
        ['pushState', '/#token'],
        ['pushState', '/?request_id=secret'],
        ['replaceState', '/share/token'],
    ] as const)('shuts down synchronously before native %s exposes %s', async (method, target) => {
        enableReplayBrowser();
        const shutdown = vi.fn();
        amplitudeMocks.sessionReplay.mockReturnValue({ shutdown });
        const analytics = await loadReplayAnalytics();
        await analytics.initAmplitude(null);
        const removeGuards = analytics.installAmplitudeReplayNavigationGuards();

        window.history[method]({}, '', target);

        expect(shutdown).toHaveBeenCalledTimes(1);
        removeGuards();
    });

    it.each(['hashchange', 'popstate'])('shuts down for a native %s location mutation', async (eventName) => {
        enableReplayBrowser();
        const shutdown = vi.fn();
        amplitudeMocks.sessionReplay.mockReturnValue({ shutdown });
        const analytics = await loadReplayAnalytics();
        await analytics.initAmplitude(null);
        const removeGuards = analytics.installAmplitudeReplayNavigationGuards();
        const location = window.location as unknown as { hash: string; href: string };
        location.hash = '#token';
        location.href = 'https://yeosachin.vercel.app/#token';

        window.dispatchEvent(new Event(eventName));

        expect(shutdown).toHaveBeenCalledTimes(1);
        removeGuards();
    });

    it('keeps a sticky shutdown while initialization is deferred across a sensitive transition', async () => {
        enableReplayBrowser();
        const shutdown = vi.fn();
        amplitudeMocks.sessionReplay.mockReturnValue({ shutdown });
        let finishInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            finishInitialization = resolve;
        }));
        const analytics = await loadReplayAnalytics();
        const removeGuards = analytics.installAmplitudeReplayNavigationGuards();
        const initialization = analytics.initAmplitude(null);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));

        window.history.pushState({}, '', '/#token');
        finishInitialization();
        await initialization;
        analytics.markAnalyticsIdentityReady();

        expect(shutdown).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.track).not.toHaveBeenCalled();
        removeGuards();
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
        analytics.trackEvent(analytics.EVENTS.ANALYSIS_DURATION_ESTIMATE_SHOWN, {
            stage: value,
            estimate_version: value,
            duration_range: value,
            mutual_count: 474,
        } as never);

        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['landing_viewed', {}],
            ['auth_started', {}],
            ['preflight_succeeded', {}],
            ['preflight_failed', { error_code: 'UNKNOWN' }],
            ['exclusion_decided', {}],
            ['payment_confirmed_viewed', {}],
            ['result_shared', {}],
            ['analysis_duration_estimate_shown', {}],
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
        analytics.trackEvent(analytics.EVENTS.ANALYSIS_DURATION_ESTIMATE_SHOWN, {
            stage: 'duration_workload',
            estimate_version: 'v1',
            duration_range: '5_8',
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
            ['analysis_duration_estimate_shown', {
                stage: 'duration_workload',
                estimate_version: 'v1',
                duration_range: '5_8',
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

    it('allows the real replay plugin to add only its reserved replay ID property', async () => {
        const replayProperty = '[Amplitude] Session Replay ID';
        const sessionId = 1_721_234_567_890;
        const plugin = new SessionReplayPlugin({ sampleRate: 0.1 });
        const evaluateTargetingAndCapture = vi.fn().mockResolvedValue(undefined);
        Object.assign(plugin as unknown as Record<string, unknown>, {
            config: { sessionId },
            sessionReplay: {
                evaluateTargetingAndCapture,
                getSessionId: () => sessionId,
                getSessionReplayProperties: () => ({ [replayProperty]: 'device/session' }),
            },
        });
        const event = {
            device_id: 'pseudonymous-device',
            event_properties: { plan_id: 'standard', stage: 'analysis' },
            event_type: 'analysis_started',
            session_id: sessionId,
            user_id: VALID_USER_ID,
        };

        const output = await plugin.execute(event as never) as unknown as typeof event;

        expect(output).toMatchObject({
            device_id: 'pseudonymous-device',
            event_type: 'analysis_started',
            session_id: sessionId,
            user_id: VALID_USER_ID,
            event_properties: {
                plan_id: 'standard',
                stage: 'analysis',
                [replayProperty]: 'device/session',
            },
        });
        expect(Object.keys(output.event_properties)).toEqual([
            'plan_id',
            'stage',
            replayProperty,
        ]);
        expect(JSON.stringify(output)).not.toContain('instagram');
        expect(evaluateTargetingAndCapture).toHaveBeenCalledWith({
            event: expect.objectContaining({ event_type: 'analysis_started' }),
            page: undefined,
            userProperties: undefined,
        });
    });

    it('contains no static Unified SDK import', () => {
        const source = readFileSync(new URL('./analytics.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/import\s+(?:\*|\{)[\s\S]*?from\s+['"]@amplitude\/unified['"]/);
        expect(source).toContain("import('@amplitude/unified')");
    });
});
