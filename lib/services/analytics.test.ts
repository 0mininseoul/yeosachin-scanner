import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, LogLevel, RemoteConfigClient } from '@amplitude/analytics-core';
import { SessionReplayPlugin } from '@amplitude/plugin-session-replay-browser';
import { SessionReplayLocalConfig } from '@amplitude/session-replay-browser/lib/cjs/config/local-config.js';
import { SessionReplayJoinedConfigGenerator } from '@amplitude/session-replay-browser/lib/cjs/config/joined-config.js';
import { SessionReplay } from '@amplitude/session-replay-browser/lib/cjs/session-replay.js';
import { getPageUrl, maskAttributeFn } from '@amplitude/session-replay-browser/lib/cjs/helpers.js';

const amplitudeMocks = vi.hoisted(() => ({
    flush: vi.fn(),
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

async function loadReplayAnalytics() {
    return loadAnalytics();
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
    vi.stubEnv('NODE_ENV', 'production');
}

describe('Amplitude analytics adapter', () => {
    beforeEach(() => {
        vi.resetModules();
        amplitudeMocks.flush.mockReset().mockReturnValue({ promise: Promise.resolve() });
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
        vi.useRealTimers();
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
            LOGIN_PROMPTED: 'login_prompted',
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
            ANALYSIS_FAILED: 'analysis_failed',
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
                        defaultMaskLevel: 'light',
                        maskSelector: ['[data-amp-mask]'],
                        blockSelector: ['[data-amp-block]'],
                    },
                    interactionConfig: {
                        enabled: true,
                        batch: true,
                        ugcFilterRules: expect.any(Array),
                    },
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

    it('preserves an absent stored user so anonymous events can merge on first authentication', async () => {
        enableBrowser();
        amplitudeMocks.getUserId.mockReturnValue(undefined);
        const { initAmplitude } = await loadAnalytics();

        await expect(initAmplitude(SECOND_UUID)).resolves.toBe(true);

        expect(amplitudeMocks.getUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
        expect(amplitudeMocks.setUserId.mock.calls).toEqual([[SECOND_UUID]]);
    });

    it('flushes pre-auth events only after assigning the authenticated Supabase UUID', async () => {
        enableBrowser();
        amplitudeMocks.getUserId.mockReturnValue(undefined);
        const analytics = await loadAnalytics();

        analytics.trackEvent(analytics.EVENTS.PLAN_VIEWED, {
            plan_id: 'standard',
            amount_krw: 1990,
            source: 'direct',
        });
        await expect(analytics.initAmplitude(SECOND_UUID)).resolves.toBe(true);

        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.track).toHaveBeenCalledWith('plan_viewed', {
            plan_id: 'standard',
            amount_krw: 1990,
            source: 'direct',
        });
        expect(amplitudeMocks.setUserId.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.track.mock.invocationCallOrder[0]);
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
            interactionConfig: { enabled: true, batch: true },
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
        expect(deterministicConfig.configs.sessionReplay.sr_privacy_config).toBeUndefined();
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

    it('rejects stale cached replay approval when the live config request times out', async () => {
        enableReplayBrowser();
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE', '1');
        const storage = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            removeItem: (key: string) => storage.delete(key),
            setItem: (key: string, value: string) => storage.set(key, value),
        });
        Object.assign(window, { localStorage: globalThis.localStorage });
        vi.stubGlobal('document', {
            createDocumentFragment: () => ({ querySelector: vi.fn() }),
        });
        const neverSettles = vi.fn(() => new Promise<Response>(() => undefined));
        vi.stubGlobal('fetch', neverSettles);
        storage.set(`AMP_remote_config_${API_KEY.substring(0, 10)}`, JSON.stringify({
            lastFetch: new Date().toISOString(),
            remoteConfig: {
                configs: {
                    sessionReplay: {
                        sr_sampling_config: { capture_enabled: true, sample_rate: 1 },
                        sr_interaction_config: { enabled: true, batch: false },
                        sr_logging_config: {
                            console: { enabled: true },
                            network: { enabled: true, body: { request: true, response: true } },
                        },
                        sr_privacy_config: {
                            defaultMaskLevel: 'light',
                            unmaskSelector: ['*'],
                        },
                    },
                },
            },
        }));
        const { initAmplitude } = await loadReplayAnalytics();
        await initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                handleFetchConfig: (request: {
                    headers: Record<string, string>;
                    method: 'GET';
                    signal?: AbortSignal;
                    url: string;
                }) => Promise<Response>;
                privacyConfig: {
                    defaultMaskLevel: string;
                    maskSelector: string[];
                };
                sampleRate: number;
            };
        };
        const localConfig = new SessionReplayLocalConfig(API_KEY, {
            ...options.sessionReplay,
            logLevel: LogLevel.None,
        } as never);
        const remoteClient = new RemoteConfigClient(
            API_KEY,
            new Logger(),
            'US',
            undefined,
            options.sessionReplay.handleFetchConfig,
        );
        const generator = new SessionReplayJoinedConfigGenerator(remoteClient, localConfig);

        vi.useFakeTimers();
        const joinedConfigPromise = generator.generateJoinedConfig();
        await vi.advanceTimersByTimeAsync(1_501);
        const { joinedConfig, remoteConfig } = await joinedConfigPromise;
        vi.useRealTimers();

        expect(neverSettles).toHaveBeenCalled();
        expect(remoteConfig).toBeUndefined();
        expect(joinedConfig.captureEnabled).toBe(false);
        expect(joinedConfig.loggingConfig).toBeUndefined();
        expect(joinedConfig.privacyConfig).toMatchObject({
            defaultMaskLevel: 'light',
            maskSelector: ['[data-amp-mask]'],
            blockSelector: ['[data-amp-block]'],
        });
        expect(joinedConfig.privacyConfig?.unmaskSelector).not.toContain('*');
    });

    it('uses the Vercel rollout sample when trusted upstream config allows capture', async () => {
        enableReplayBrowser();
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE', '1');
        const hostileRemoteConfig = {
            configs: {
                sessionReplay: {
                    sr_sampling_config: { capture_enabled: true, sample_rate: 0.05 },
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
        expect(options.sessionReplay.sampleRate).toBe(1);
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
                    sr_sampling_config: { capture_enabled: true, sample_rate: 1 },
                    sr_interaction_config: { enabled: true, batch: true },
                    sr_privacy_config: {
                        defaultMaskLevel: 'light',
                        maskSelector: ['[data-amp-mask]'],
                        blockSelector: ['[data-amp-block]'],
                    },
                },
            },
        });
    });

    it.each([
        '/',
        '/privacy',
        '/terms',
        '/login',
        '/analyze',
        '/betatest',
        '/earlybird',
        '/mypage',
        '/progress/demo-request-id',
        '/result/demo-request-id',
        '/share/demo-token',
    ])(
        'keeps eligible replay enabled at %s with interaction batching',
        async (pathname) => {
            enableReplayBrowser({ pathname });
            const { initAmplitude } = await loadReplayAnalytics();

            await expect(initAmplitude(null)).resolves.toBe(true);

            const options = amplitudeMocks.initAll.mock.calls[0][1] as {
                sessionReplay: {
                    privacyConfig: { maskSelector: string[] };
                    interactionConfig: { enabled: boolean; batch: boolean; ugcFilterRules: unknown[] };
                    sampleRate: number;
                };
            };
            expect(options.sessionReplay.sampleRate).toBe(0.1);
            expect(options.sessionReplay.interactionConfig).toMatchObject({ enabled: true, batch: true });
            expect(options.sessionReplay.interactionConfig.ugcFilterRules).not.toHaveLength(0);
            expect(options.sessionReplay.privacyConfig.maskSelector).toEqual(['[data-amp-mask]']);
        },
    );

    it('sanitizes synthetic identifiers, queries, and hashes for replay meta and interaction URLs', async () => {
        const requestId = '11111111-1111-4111-8111-111111111111';
        const shareToken = 'synthetic-share-token-that-must-never-persist';
        enableReplayBrowser({ pathname: `/progress/${requestId}`, search: '?email=person@example.com', hash: '#details' });
        const { initAmplitude } = await loadReplayAnalytics();

        await initAmplitude(null);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { interactionConfig: { ugcFilterRules: Array<{ selector: string; replacement: string }> } };
        };
        const rules = options.sessionReplay.interactionConfig.ugcFilterRules;
        const rawUrls = [
            'https://production-alias.example/?email=person@example.com#details',
            'http://preview-alias.example/privacy?email=person@example.com#details',
            'https://custom-alias.example/terms?email=person@example.com#details',
            'http://production-alias.example/login?email=person@example.com#details',
            'https://preview-alias.example/analyze?email=person@example.com#details',
            'https://preview-alias.example/betatest?email=person@example.com#details',
            'http://custom-alias.example/betatest?email=person@example.com#details',
            'http://custom-alias.example/earlybird?email=person@example.com#details',
            'https://production-alias.example/mypage?email=person@example.com#details',
            `https://production-alias.example/progress/${requestId}?email=person@example.com#details`,
            `http://preview-alias.example/result/${requestId}?source=private#summary`,
            `https://custom-alias.example/share/${shareToken}?phone=01012345678#open`,
        ];
        const sanitized = rawUrls.map((url) => getPageUrl(url, rules));

        expect(sanitized).toEqual([
            '/', '/privacy', '/terms', '/login', '/analyze', '/betatest', '/betatest', '/earlybird', '/mypage',
            '/progress/:requestId', '/result/:requestId', '/share/:token',
        ]);
        expect(JSON.stringify(sanitized)).not.toContain(requestId);
        expect(JSON.stringify(sanitized)).not.toContain(shareToken);
        expect(JSON.stringify(sanitized)).not.toContain('person@example.com');
        expect(JSON.stringify(sanitized)).not.toContain('01012345678');
    });

    it.each([
        '/admin/analysis-audit',
        '/api/analysis/run',
        '/unknown-route',
    ])('never enables initial replay on an ineligible route %s', async (pathname) => {
        enableReplayBrowser({ pathname });
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        const { initAmplitude } = await loadReplayAnalytics();

        await expect(initAmplitude(null)).resolves.toBe(true);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { sampleRate: number };
        };
        expect(options.sessionReplay.sampleRate).toBe(0);
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

    it('enables the exact 1.0 production replay beta sample', async () => {
        enableReplayBrowser();
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE', '1');
        const { initAmplitude } = await loadReplayAnalytics();

        await expect(initAmplitude(null)).resolves.toBe(true);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { sampleRate: number };
        };
        expect(options.sessionReplay.sampleRate).toBe(1);
    });

    it.each(['1.0', '1.01', '2'])('fails replay closed for invalid production replay sample %s', async (sampleRate) => {
        enableReplayBrowser();
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE', sampleRate);
        const { initAmplitude } = await loadReplayAnalytics();

        await expect(initAmplitude(null)).resolves.toBe(true);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { sampleRate: number };
        };
        expect(options.sessionReplay.sampleRate).toBe(0);
    });

    it.each(['', 'test', 'development'])('never enables replay outside a production build %j', async (nodeEnv) => {
        enableReplayBrowser();
        vi.stubEnv('NODE_ENV', nodeEnv);
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
        vi.stubEnv('NODE_ENV', nodeEnv);
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED', enabled);
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE', sampleRate);
        const { initAmplitude } = await loadReplayAnalytics();

        await expect(initAmplitude(null)).resolves.toBe(true);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as { sessionReplay: { sampleRate: number } };
        expect(options.sessionReplay.sampleRate).toBe(0);
    });

    it('keeps replay eligible on a result route without changing funnel delivery', async () => {
        enableReplayBrowser({ pathname: '/result/request-id' });
        const analytics = await loadReplayAnalytics();

        await expect(analytics.initAmplitude(null)).resolves.toBe(true);
        analytics.markAnalyticsIdentityReady();
        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, { source: 'direct' });
        const options = amplitudeMocks.initAll.mock.calls[0][1] as { sessionReplay: { sampleRate: number } };
        expect(options.sessionReplay.sampleRate).toBe(0.1);
        expect(amplitudeMocks.track).toHaveBeenCalledWith('landing_viewed', { source: 'direct' });
    });

    it('fails replay closed when upstream config is unavailable, malformed, or disables capture', async () => {
        enableReplayBrowser();
        const configFetch = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(new Response(JSON.stringify({ configs: { sessionReplay: {} } })))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                configs: {
                    sessionReplay: { sr_sampling_config: { capture_enabled: false, sample_rate: 1 } },
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

    it('fails replay closed when the route becomes ineligible during upstream config fetch', async () => {
        enableReplayBrowser();
        let resolveFetch!: (response: Response) => void;
        const configFetch = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
            resolveFetch = resolve;
        }));
        vi.stubGlobal('fetch', configFetch);
        const { initAmplitude } = await loadReplayAnalytics();
        await initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { handleFetchConfig: (request: { headers: Record<string, string>; method: 'GET'; url: string }) => Promise<Response> };
        };

        const responsePromise = options.sessionReplay.handleFetchConfig({
            headers: { Accept: '*/*' },
            method: 'GET',
            url: `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser`,
        });
        (window.location as unknown as { pathname: string }).pathname = '/admin/analysis-audit';
        resolveFetch(new Response(JSON.stringify({
            configs: { sessionReplay: { sr_sampling_config: { capture_enabled: true, sample_rate: 0.1 } } },
        })));

        expect(await responsePromise.then((response) => response.json())).toEqual({
            configs: {
                sessionReplay: {
                    sr_sampling_config: { capture_enabled: false, sample_rate: 0 },
                },
            },
        });
    });

    it('fails replay closed when privacy opt-out appears during upstream config fetch', async () => {
        enableReplayBrowser();
        let resolveFetch!: (response: Response) => void;
        const configFetch = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
            resolveFetch = resolve;
        }));
        vi.stubGlobal('fetch', configFetch);
        const { initAmplitude } = await loadReplayAnalytics();
        await initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: { handleFetchConfig: (request: { headers: Record<string, string>; method: 'GET'; url: string }) => Promise<Response> };
        };

        const responsePromise = options.sessionReplay.handleFetchConfig({
            headers: { Accept: '*/*' },
            method: 'GET',
            url: `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser`,
        });
        (window.navigator as unknown as { doNotTrack?: string }).doNotTrack = '1';
        resolveFetch(new Response(JSON.stringify({
            configs: { sessionReplay: { sr_sampling_config: { capture_enabled: true, sample_rate: 0.1 } } },
        })));

        expect(await responsePromise.then((response) => response.json())).toEqual({
            configs: {
                sessionReplay: {
                    sr_sampling_config: { capture_enabled: false, sample_rate: 0 },
                },
            },
        });
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

    it('stops replay exactly once when a route becomes ineligible and on teardown', async () => {
        enableReplayBrowser();
        const shutdown = vi.fn();
        amplitudeMocks.sessionReplay.mockReturnValue({ shutdown });
        const analytics = await loadReplayAnalytics();
        await analytics.initAmplitude(null);

        const location = (window as unknown as { location: { pathname: string; search: string; hash: string } }).location;
        location.pathname = '/admin/analysis-audit';
        analytics.enforceAmplitudeReplayRoutePrivacy();
        analytics.enforceAmplitudeReplayRoutePrivacy();
        analytics.teardownAmplitudeSessionReplay();

        expect(shutdown).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
    });

    it('keeps replay upload enabled when an eligible route has a query or hash', async () => {
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

        expect(response.status).toBe(200);
        expect(replayFetch).toHaveBeenCalledTimes(1);
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

    it('does not globally mask common attributes before the replay SDK serializes them', async () => {
        enableReplayBrowser();
        const analytics = await loadReplayAnalytics();
        await analytics.initAmplitude(null);
        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                privacyConfig: {
                    defaultMaskLevel: 'light';
                    maskAttributes?: string[];
                };
            };
        };
        const attributeMask = maskAttributeFn(
            options.sessionReplay.privacyConfig,
            () => 'https://production-alias.example/analyze',
        );
        const genericElement = { closest: () => null, tagName: 'A' } as unknown as HTMLElement;
        const rawAttributes = {
            href: 'https://private.example/target',
            src: 'https://private.example/avatar.jpg',
            alt: 'private profile photo',
            title: 'private tooltip',
            'aria-label': 'private control',
            value: 'private input value',
            placeholder: 'private input hint',
        };
        const serializedAttributes = Object.fromEntries(
            Object.entries(rawAttributes).map(([key, value]) => [
                key,
                attributeMask(key, value, genericElement),
            ]),
        );

        expect(options.sessionReplay.privacyConfig.defaultMaskLevel).toBe('light');
        expect(options.sessionReplay.privacyConfig.maskAttributes).toBeUndefined();
        expect(serializedAttributes).toEqual(rawAttributes);
    });

    it('forwards the installed SDK least restrictive privacy level through the replay adapter', async () => {
        const plugin = new SessionReplayPlugin({
            privacyConfig: {
                defaultMaskLevel: 'light',
            },
        } as never);
        const init = vi.fn().mockReturnValue({ promise: Promise.resolve() });
        plugin.sessionReplay = { init } as never;

        await plugin.setup({
            apiKey: 'test-key',
            deviceId: 'test-device',
            flushMaxRetries: 2,
            instanceName: 'adapter-runtime-test',
            loggerProvider: new Logger(),
            logLevel: LogLevel.Warn,
            optOut: false,
            serverZone: 'US',
            sessionId: 1,
        } as never, {} as never);

        const receivedOptions = init.mock.calls[0]?.[1] as {
            privacyConfig?: { defaultMaskLevel?: string };
        };
        expect(receivedOptions.privacyConfig?.defaultMaskLevel).toBe('light');
    });

    it('delivers narrow marked-region masking through the initial joined replay config', async () => {
        enableReplayBrowser();
        const analytics = await loadReplayAnalytics();

        await analytics.initAmplitude(null);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                handleFetchConfig: (request: {
                    headers: Record<string, string>;
                    method: 'GET';
                    url: string;
                }) => Promise<Response>;
                privacyConfig: {
                    defaultMaskLevel: 'light';
                    maskSelector: string[];
                };
            };
        };
        vi.stubGlobal('document', {
            createDocumentFragment: () => ({ querySelector: vi.fn() }),
        });
        const response = await options.sessionReplay.handleFetchConfig({
            headers: {},
            method: 'GET',
            url: `https://sr-client-cfg.amplitude.com/config/${API_KEY}?config_group=browser`,
        });
        const payload = await response.json() as {
            configs: { sessionReplay: Record<string, unknown> };
        };
        const remoteClient = {
            subscribe: vi.fn((
                _key: string | undefined,
                _deliveryMode: unknown,
                callback: (config: Record<string, unknown>, source: 'remote', lastFetch: Date) => void,
            ) => {
                callback(payload.configs.sessionReplay, 'remote', new Date());
                return 'safe-config-subscription';
            }),
        };
        const localConfig = new SessionReplayLocalConfig(API_KEY, options.sessionReplay as never);
        const generator = new SessionReplayJoinedConfigGenerator(remoteClient as never, localConfig);
        const { joinedConfig } = await generator.generateJoinedConfig();

        expect(joinedConfig.privacyConfig).toMatchObject({
            defaultMaskLevel: 'light',
            maskSelector: ['[data-amp-mask]'],
            blockSelector: ['[data-amp-block]'],
        });
        expect(joinedConfig.privacyConfig?.maskAttributes).toBeUndefined();
        const attributeMask = maskAttributeFn(
            joinedConfig.privacyConfig ?? {},
            () => 'https://production-alias.example/analyze',
        );
        const element = { closest: () => null, tagName: 'A' } as unknown as HTMLElement;
        expect(attributeMask('href', 'https://private.example/target', element)).toBe('https://private.example/target');
    });

    it('uploads an exact interaction batch through the replay transport', async () => {
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
        const url = 'https://api-sr.amplitude.com/sessions/v2/track?device_id=device&session_id=1721234567890&type=interaction';

        const response = await options.sessionReplay.handleSendEvents({
            body: 'safe-interaction-payload',
            headers: { Authorization: `Bearer ${API_KEY}` },
            keepalive: true,
            method: 'POST',
            url,
        });

        expect(response.status).toBe(200);
        expect(replayFetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST' }));
    });

    it('drops a non-allowlisted replay transport type', async () => {
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

        const response = await options.sessionReplay.handleSendEvents({
            body: 'unsafe-payload',
            headers: { Authorization: `Bearer ${API_KEY}` },
            keepalive: true,
            method: 'POST',
            url: 'https://api-sr.amplitude.com/sessions/v2/track?device_id=device&session_id=1721234567890&type=console',
        });

        expect(response.status).toBe(204);
        expect(replayFetch).not.toHaveBeenCalled();
    });

    it.each([
        ['pushState', '/#token'],
        ['pushState', '/?request_id=secret'],
        ['replaceState', '/share/token'],
    ] as const)('keeps replay active for an eligible native %s transition to %s', async (method, target) => {
        enableReplayBrowser();
        const shutdown = vi.fn();
        amplitudeMocks.sessionReplay.mockReturnValue({ shutdown });
        const analytics = await loadReplayAnalytics();
        await analytics.initAmplitude(null);
        const removeGuards = analytics.installAmplitudeReplayNavigationGuards();

        window.history[method]({}, '', target);

        expect(shutdown).not.toHaveBeenCalled();
        removeGuards();
    });

    it.each(['hashchange', 'popstate'])('keeps replay active for an eligible native %s location mutation', async (eventName) => {
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

        expect(shutdown).not.toHaveBeenCalled();
        removeGuards();
    });

    it('keeps a sticky shutdown while initialization is deferred across an ineligible transition', async () => {
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

        window.history.pushState({}, '', '/admin/analysis-audit');
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

    it('flushes initialized analytics at a navigation boundary without bypassing identity readiness', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();

        await analytics.initAmplitude(VALID_USER_ID);
        vi.useFakeTimers();
        const pendingIdentityFlush = analytics.flushAnalytics();
        await vi.advanceTimersByTimeAsync(500);
        await pendingIdentityFlush;
        expect(amplitudeMocks.flush).not.toHaveBeenCalled();

        analytics.markAnalyticsIdentityReady();
        analytics.trackEvent(analytics.EVENTS.CHECKOUT_REDIRECTED, {
            plan_id: 'standard',
            amount_krw: 9900,
        });
        await analytics.flushAnalytics();

        expect(amplitudeMocks.flush).toHaveBeenCalledTimes(1);
    });

    it('waits briefly for an in-flight identity initialization before flushing', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const analytics = await loadAnalytics();
        const initialization = analytics.initAmplitude(VALID_USER_ID);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));

        vi.useFakeTimers();
        const pendingFlush = analytics.flushAnalytics();
        await vi.advanceTimersByTimeAsync(25);
        expect(amplitudeMocks.flush).not.toHaveBeenCalled();

        resolveInitialization();
        await initialization;
        analytics.markAnalyticsIdentityReady();
        await vi.advanceTimersByTimeAsync(25);
        await expect(pendingFlush).resolves.toBeUndefined();
        expect(amplitudeMocks.flush).toHaveBeenCalledTimes(1);
    });

    it('bounds a hanging SDK flush so checkout navigation is never held indefinitely', async () => {
        enableBrowser();
        amplitudeMocks.flush.mockReturnValue({ promise: new Promise<void>(() => undefined) });
        const analytics = await loadAnalytics();

        await analytics.initAmplitude(VALID_USER_ID);
        analytics.markAnalyticsIdentityReady();
        vi.useFakeTimers();
        const pendingFlush = analytics.flushAnalytics();

        await vi.advanceTimersByTimeAsync(500);
        await expect(pendingFlush).resolves.toBeUndefined();
        expect(amplitudeMocks.flush).toHaveBeenCalledTimes(1);
    });

    it('absorbs a late SDK flush rejection after the bounded wait returns', async () => {
        enableBrowser();
        let rejectFlush!: (reason?: unknown) => void;
        amplitudeMocks.flush.mockReturnValue({
            promise: new Promise<void>((_resolve, reject) => {
                rejectFlush = reject;
            }),
        });
        const analytics = await loadAnalytics();

        await analytics.initAmplitude(VALID_USER_ID);
        analytics.markAnalyticsIdentityReady();
        vi.useFakeTimers();
        const pendingFlush = analytics.flushAnalytics();

        await vi.advanceTimersByTimeAsync(500);
        await expect(pendingFlush).resolves.toBeUndefined();
        rejectFlush(new Error('late transport failure'));
        await Promise.resolve();
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

    it('accepts normalized ChatGPT referral attribution but rejects its raw source', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude(null);
        analytics.markAnalyticsIdentityReady();

        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, {
            source: 'chatgpt',
            medium: 'referral',
        });
        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, {
            source: 'chatgpt.com',
            medium: 'referral',
            referrer: 'https://chatgpt.com/share/private',
            query: 'private search query',
            url: 'https://yeosachin.com/?utm_source=chatgpt.com',
        });

        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['landing_viewed', {
                source: 'chatgpt',
                medium: 'referral',
            }],
            ['landing_viewed', {
                medium: 'referral',
            }],
        ]);
        expect(JSON.stringify(amplitudeMocks.track.mock.calls)).not.toMatch(
            /chatgpt\.com|private search query|utm_source|referrer/,
        );
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
