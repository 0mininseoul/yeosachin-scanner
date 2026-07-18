import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPageUrl } from '@amplitude/session-replay-browser/lib/cjs/helpers.js';
import { SessionReplayTrackDestination } from '@amplitude/session-replay-browser/lib/cjs/track-destination.js';

const amplitudeMocks = vi.hoisted(() => ({
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

    it('sets anonymous identity before one safe initialization and returns deterministic replay config', async () => {
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
        expect(amplitudeMocks.setUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId).toHaveBeenCalledWith(undefined);
        expect(amplitudeMocks.setUserId.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.initAll.mock.invocationCallOrder[0]);
        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                handleFetchConfig: (request: unknown) => Promise<Response>;
            };
        };
        expect(options).toEqual({
            analytics: {
                autocapture: {
                    sessions: true,
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
                sampleRate: 1,
                privacyConfig: {
                    defaultMaskLevel: 'conservative',
                    maskSelector: ['.amp-mask', '[data-amp-mask]'],
                    blockSelector: ['.amp-block', '[data-amp-block]'],
                },
                interactionConfig: {
                    enabled: true,
                    batch: false,
                    ugcFilterRules: [
                        {
                            selector: 'https://*/**',
                            replacement: 'https://yeosachin.vercel.app/',
                        },
                        {
                            selector: 'http://*/**',
                            replacement: 'http://localhost/',
                        },
                    ],
                },
                performanceConfig: { enabled: false },
                captureDocumentTitle: false,
                enableUrlChangePolling: false,
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
                        sample_rate: 1,
                        capture_enabled: true,
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

    it('removes sensitive URLs from an installed-SDK replay upload and transport header', async () => {
        const shareToken = 'a'.repeat(64);
        const requestId = '11111111-1111-4111-8111-111111111111';
        const preflightId = '22222222-2222-4222-8222-222222222222';
        const sensitiveUrl = `https://yeosachin.vercel.app/share/${shareToken}`
            + `?preflight=${preflightId}#result/${requestId}`;
        const fetchCapture = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
        enableBrowser();
        vi.stubGlobal('location', { href: sensitiveUrl });
        vi.stubGlobal('fetch', fetchCapture);
        const { initAmplitude } = await loadAnalytics();

        await initAmplitude(null);

        const options = amplitudeMocks.initAll.mock.calls[0][1] as {
            sessionReplay: {
                interactionConfig: {
                    enabled: boolean;
                    ugcFilterRules: Array<{ selector: string; replacement: string }>;
                };
                handleSendEvents: (request: {
                    url: string;
                    method: 'POST';
                    headers: Record<string, string>;
                    body: string | Uint8Array;
                    keepalive: boolean;
                }) => Promise<Response>;
            };
        };
        expect(options.sessionReplay.interactionConfig.enabled).toBe(true);

        for (const pageUrl of [
            sensitiveUrl,
            `https://yeosachin.vercel.app/analyze?preflight=${preflightId}`,
            `https://yeosachin.vercel.app/progress/${requestId}`,
            `https://yeosachin.vercel.app/result/${requestId}?pipeline=v2`,
        ]) {
            expect(getPageUrl(
                pageUrl,
                options.sessionReplay.interactionConfig.ugcFilterRules,
            )).toBe('https://yeosachin.vercel.app/');
        }
        expect(getPageUrl(
            `http://127.0.0.1:3000/result/${requestId}?pipeline=v2`,
            options.sessionReplay.interactionConfig.ugcFilterRules,
        )).toBe('http://localhost/');

        const sanitizedPageUrl = getPageUrl(
            sensitiveUrl,
            options.sessionReplay.interactionConfig.ugcFilterRules,
        );
        const replayEvent = JSON.stringify({
            type: 4,
            data: { href: sanitizedPageUrl },
        });
        const expectedBody = JSON.stringify({ version: 1, events: [replayEvent] });
        const noop = vi.fn();
        const destination = new SessionReplayTrackDestination({
            loggerProvider: {
                debug: noop,
                disable: noop,
                enable: noop,
                error: noop,
                log: noop,
                warn: noop,
            },
            enableTransportCompression: false,
            sendTimeoutMs: 0,
            handleSendEvents: options.sessionReplay.handleSendEvents,
        });

        await destination.send({
            events: [replayEvent],
            sampleRate: 1,
            type: 'replay',
            sessionId: 1_721_234_567_890,
            deviceId: 'test-device',
            apiKey: API_KEY,
            onComplete: async () => undefined,
            attempts: 1,
            timeout: 0,
            flushMaxRetries: 2,
        });

        expect(fetchCapture).toHaveBeenCalledTimes(1);
        const [uploadUrl, request] = fetchCapture.mock.calls[0] as [string, RequestInit];
        expect(uploadUrl).toContain('session_id=1721234567890');
        expect(request.method).toBe('POST');
        expect(request.keepalive).toBe(true);
        expect(request.body).toBe(expectedBody);
        const uploadedHeaders = new Headers(request.headers);
        expect(uploadedHeaders.get('X-Client-Url')).toBe('https://yeosachin.vercel.app/');
        expect(uploadedHeaders.get('Authorization')).toBe(`Bearer ${API_KEY}`);
        expect(uploadedHeaders.get('Content-Type')).toBe('application/json');

        const wireImage = JSON.stringify({ uploadUrl, request: {
            ...request,
            body: typeof request.body === 'string' ? request.body : '<binary>',
            headers: Object.fromEntries(new Headers(request.headers).entries()),
        } });
        expect(wireImage).toContain('https://yeosachin.vercel.app/');
        for (const forbidden of [
            shareToken,
            requestId,
            preflightId,
            '/share/',
            '?preflight=',
            '#result/',
        ]) {
            expect(wireImage).not.toContain(forbidden);
        }
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

        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });
        expect(amplitudeMocks.initAll).not.toHaveBeenCalled();

        const initialization = analytics.initAmplitude(null);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));
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

    it('bounds the pre-init queue to the latest 50 validated invocations', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();

        for (let resultCount = 0; resultCount < 55; resultCount += 1) {
            analytics.trackEvent(analytics.EVENTS.RESULT_VIEWED, {
                request_id: VALID_USER_ID,
                result_count: resultCount,
                is_shared: false,
            });
        }

        expect(amplitudeMocks.initAll).not.toHaveBeenCalled();
        await analytics.initAmplitude(null);
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

    it('uses the latest auth identity when auth changes during initialization', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const analytics = await loadAnalytics();
        analytics.trackEvent(analytics.EVENTS.AUTH_COMPLETED, { provider: 'kakao' });

        const authenticatedInit = analytics.initAmplitude(VALID_USER_ID);
        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));
        const anonymousInit = analytics.initAmplitude(null);
        analytics.markAnalyticsIdentityPending();

        resolveInitialization();
        await Promise.all([authenticatedInit, anonymousInit]);
        expect(amplitudeMocks.setUserId.mock.calls.at(-1)).toEqual([undefined]);
        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        analytics.markAnalyticsIdentityReady();
        expect(amplitudeMocks.track).toHaveBeenCalledWith('auth_completed', {
            provider: 'kakao',
        });
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

    it('ignores unapproved events and contains SDK errors', async () => {
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
        amplitudeMocks.setUserId.mockImplementationOnce(() => {
            throw new Error('identity failed');
        });
        await expect(analytics.initAmplitude(null)).resolves.toBe(true);
    });

    it('sets UUID or undefined without resetting device identity', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();

        await analytics.initAmplitude(VALID_USER_ID);
        await analytics.initAmplitude(null);
        await analytics.initAmplitude('person@example.com' as never);

        expect(amplitudeMocks.setUserId.mock.calls).toEqual([
            [VALID_USER_ID],
            [undefined],
        ]);
        expect(amplitudeMocks.reset).not.toHaveBeenCalled();
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
    });

    it('contains no static Unified SDK import', () => {
        const source = readFileSync(new URL('./analytics.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/import\s+(?:\*|\{)[\s\S]*?from\s+['"]@amplitude\/unified['"]/);
        expect(source).toContain("import('@amplitude/unified')");
    });
});
