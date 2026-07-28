'use client';

export const EVENTS = {
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
} as const;

export type AnalyticsEvent = (typeof EVENTS)[keyof typeof EVENTS];
export type AnalyticsAuthProvider = 'google' | 'kakao';
export type AnalyticsShareChannel = 'clipboard' | 'kakao' | 'web_share';

type UnifiedSdk = typeof import('@amplitude/unified');
type AnalyticsScalar = string | number | boolean;
type AnalyticsProperties = Record<string, AnalyticsScalar>;

type PropertyName =
    | 'amount_krw'
    | 'campaign'
    | 'content'
    | 'decision'
    | 'duration_ms'
    | 'duration_range'
    | 'estimate_version'
    | 'error_code'
    | 'followers_bucket'
    | 'following_bucket'
    | 'is_shared'
    | 'medium'
    | 'order_id'
    | 'plan_id'
    | 'preflight_id'
    | 'provider'
    | 'request_id'
    | 'required_plan_id'
    | 'result_count'
    | 'share_channel'
    | 'source'
    | 'stage'
    | 'status'
    | 'term';

type PropertyValidator = (value: unknown) => AnalyticsScalar | undefined;

const API_KEY_PATTERN = /^[0-9a-f]{32}$/i;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUEUED_EVENTS = 50;
const SESSION_REPLAY_MAX_SAMPLE_RATE = 0.1;
const SESSION_REPLAY_SAFE_PATHS = new Set(['/', '/privacy', '/terms']);
const SESSION_REPLAY_MASK_SELECTORS = [
    '.amp-mask',
    '[data-amp-mask]',
    'form',
    'input',
    'textarea',
    'select',
    'option',
    '[contenteditable]',
] as const;
const SESSION_REPLAY_BLOCK_SELECTORS = [
    '.amp-block',
    '[data-amp-block]',
    '[data-amp-sensitive]',
    '[data-amp-private]',
    'img',
    'video',
    'audio',
    'canvas',
    'svg',
] as const;

const APPROVED_EVENTS = new Set<AnalyticsEvent>(Object.values(EVENTS));

function enumValidator<const T extends string>(values: readonly T[]): PropertyValidator {
    const allowed = new Set<string>(values);
    return (value) => typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function integerValidator(minimum: number, maximum: number): PropertyValidator {
    return (value) => typeof value === 'number'
        && Number.isFinite(value)
        && Number.isInteger(value)
        && value >= minimum
        && value <= maximum
        ? value
        : undefined;
}

function uuidValidator(value: unknown): string | undefined {
    return typeof value === 'string' && CANONICAL_UUID.test(value) ? value : undefined;
}

const errorCodeValidator = enumValidator([
    'INTERNAL_ERROR',
    'NETWORK_ERROR',
    'NOT_FOUND',
    'PROVIDER_ERROR',
    'RATE_LIMITED',
    'TIMEOUT',
    'UNAUTHORIZED',
    'UNKNOWN',
    'VALIDATION_ERROR',
] as const);

function registeredErrorCodeValidator(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const validated = errorCodeValidator(value);
    return typeof validated === 'string' ? validated : 'UNKNOWN';
}

const PROPERTY_VALIDATORS: Record<PropertyName, PropertyValidator> = {
    amount_krw: integerValidator(0, 10_000_000),
    campaign: enumValidator(['launch_2026']),
    content: enumValidator(['hero-a']),
    decision: enumValidator(['exclude', 'skip']),
    duration_ms: integerValidator(0, 86_400_000),
    duration_range: enumValidator(['4_6', '5_8', '8_12', '10_15', '60_90_seconds']),
    error_code: registeredErrorCodeValidator,
    estimate_version: enumValidator(['v1', 'demo-v1']),
    followers_bucket: enumValidator(['unknown', '0_400', '401_800', '801_1200', 'over_1200']),
    following_bucket: enumValidator(['unknown', '0_400', '401_800', '801_1200', 'over_1200']),
    is_shared: (value) => typeof value === 'boolean' ? value : undefined,
    medium: enumValidator(['direct', 'organic', 'paid_social', 'referral']),
    order_id: uuidValidator,
    plan_id: enumValidator(['basic', 'standard', 'plus']),
    preflight_id: uuidValidator,
    provider: enumValidator(['google', 'kakao']),
    request_id: uuidValidator,
    required_plan_id: enumValidator(['basic', 'standard', 'plus']),
    result_count: integerValidator(0, 10_000),
    share_channel: enumValidator(['clipboard', 'kakao', 'web_share']),
    source: enumValidator(['direct', 'google', 'instagram', 'kakao']),
    stage: enumValidator([
        'analysis',
        'anonymous',
        'authenticated',
        'checkout',
        'duration_demo',
        'duration_preflight',
        'duration_workload',
        'preflight',
        'profile',
        'relationships',
        'result',
    ]),
    status: enumValidator([
        'analysis_in_progress',
        'cancelled',
        'completed',
        'overflow_refund_required',
        'paid',
        'payment_failed',
        'payment_pending',
        'refund_pending',
        'refunded',
    ]),
    term: enumValidator(['detector']),
};

const EVENT_SCHEMAS: Record<AnalyticsEvent, readonly PropertyName[]> = {
    [EVENTS.LANDING_VIEWED]: ['source', 'medium', 'campaign', 'content', 'term'],
    [EVENTS.TARGET_SUBMITTED]: ['stage'],
    [EVENTS.AUTH_STARTED]: ['provider'],
    [EVENTS.AUTH_COMPLETED]: ['provider'],
    [EVENTS.PREFLIGHT_STARTED]: [],
    [EVENTS.PREFLIGHT_SUCCEEDED]: [
        'duration_ms',
        'required_plan_id',
        'followers_bucket',
        'following_bucket',
        'preflight_id',
    ],
    [EVENTS.PREFLIGHT_FAILED]: ['duration_ms', 'error_code', 'stage', 'preflight_id'],
    [EVENTS.EXCLUSION_DECIDED]: ['preflight_id', 'decision'],
    [EVENTS.PLAN_VIEWED]: ['plan_id', 'required_plan_id', 'amount_krw', 'preflight_id'],
    [EVENTS.PLAN_SELECTED]: ['plan_id', 'required_plan_id', 'amount_krw', 'preflight_id'],
    [EVENTS.CHECKOUT_STARTED]: ['plan_id', 'amount_krw', 'preflight_id'],
    [EVENTS.CHECKOUT_REDIRECTED]: ['plan_id', 'amount_krw', 'preflight_id'],
    [EVENTS.PAYMENT_CONFIRMED_VIEWED]: ['order_id', 'plan_id', 'amount_krw', 'status'],
    [EVENTS.EARLYBIRD_STATUS_VIEWED]: ['order_id', 'plan_id', 'amount_krw', 'status'],
    [EVENTS.ANALYSIS_STARTED]: ['request_id', 'plan_id', 'preflight_id'],
    [EVENTS.ANALYSIS_DURATION_ESTIMATE_SHOWN]: ['stage', 'estimate_version', 'duration_range'],
    [EVENTS.ANALYSIS_COMPLETED]: ['request_id', 'duration_ms'],
    [EVENTS.RESULT_VIEWED]: ['request_id', 'result_count', 'is_shared'],
    [EVENTS.RESULT_SHARED]: ['request_id', 'share_channel'],
};

interface QueuedEvent {
    eventName: AnalyticsEvent;
    identityRevision: number;
    properties: AnalyticsProperties;
}

let identityReady = false;
let initializationPromise: Promise<boolean> | null = null;
let initializedSdk: UnifiedSdk | null = null;
let sdkLoadPromise: Promise<UnifiedSdk> | null = null;
let desiredUserId: string | undefined;
let hasResolvedIdentity = false;
let identityDeliveryBlocked = false;
let identityReconciled = false;
let identityRevision = 0;
let hasInspectedSdkIdentity = false;
let pendingIdentityReset = false;
let replayShutdown = false;
let replayShutdownRequested = false;
let navigationGuardConsumers = 0;
let removeNavigationGuards: (() => void) | null = null;
const queuedEvents: QueuedEvent[] = [];

interface ReplaySamplingConfig {
    captureEnabled: boolean;
    sampleRate: number;
}

interface ReplayLocation {
    hash: string;
    pathname: string;
    search: string;
}

interface ReplayNavigator {
    doNotTrack?: string | null;
    globalPrivacyControl?: boolean;
}

function configuredApiKey(): string | null {
    if (typeof window === 'undefined') return null;

    const apiKey = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY?.trim() ?? '';
    if (!API_KEY_PATTERN.test(apiKey) || /^([0-9a-f])\1{31}$/i.test(apiKey)) return null;
    return apiKey;
}

function currentReplayLocation(): ReplayLocation | null {
    if (typeof window === 'undefined') return null;
    const location = window.location;
    if (!location) return null;
    return {
        hash: location.hash,
        pathname: location.pathname,
        search: location.search,
    };
}

function isReplaySafeLocation(location: ReplayLocation | null = currentReplayLocation()): boolean {
    return Boolean(
        location
        && SESSION_REPLAY_SAFE_PATHS.has(location.pathname)
        && location.search.length === 0
        && location.hash.length === 0,
    );
}

function hasReplayPrivacyOptOut(): boolean {
    if (typeof window === 'undefined') return true;
    const navigator = window.navigator as ReplayNavigator | undefined;
    const doNotTrack = navigator?.doNotTrack?.toLowerCase();
    return doNotTrack === '1' || doNotTrack === 'yes' || navigator?.globalPrivacyControl === true;
}

function isReplayProductionEnvironment(): boolean {
    return process.env.NEXT_PUBLIC_VERCEL_ENV === 'production';
}

function configuredReplaySampling(): ReplaySamplingConfig {
    const disabled = { captureEnabled: false, sampleRate: 0 } as const;
    if (
        typeof window === 'undefined'
        || !isReplayProductionEnvironment()
        || process.env.NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED !== 'true'
        || replayShutdownRequested
        || hasReplayPrivacyOptOut()
        || !isReplaySafeLocation()
    ) {
        return disabled;
    }

    const rawSampleRate = process.env.NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE ?? '';
    if (!/^0\.(?:0[1-9]|1|10)$/.test(rawSampleRate)) return disabled;
    const sampleRate = Number(rawSampleRate);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > SESSION_REPLAY_MAX_SAMPLE_RATE) {
        return disabled;
    }

    return { captureEnabled: true, sampleRate };
}

function replayRemoteConfig(sampling: ReplaySamplingConfig) {
    return {
        configs: {
            sessionReplay: {
                sr_sampling_config: {
                    sample_rate: sampling.sampleRate,
                    capture_enabled: sampling.captureEnabled,
                },
            },
        },
    } as const;
}

function replayConfigResponse(sampling: ReplaySamplingConfig): Response {
    return new Response(JSON.stringify(replayRemoteConfig(sampling)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function isTrustedReplayConfigUrl(value: string, apiKey: string): boolean {
    return value === `https://sr-client-cfg.amplitude.com/config/${apiKey}?config_group=browser`;
}

function hasExpectedReplaySampling(value: unknown, expected: ReplaySamplingConfig): boolean {
    if (!expected.captureEnabled || typeof value !== 'object' || value === null) return false;
    const payload = value as {
        configs?: { sessionReplay?: { sr_sampling_config?: unknown } };
    };
    const sampling = payload.configs?.sessionReplay?.sr_sampling_config;
    return typeof sampling === 'object'
        && sampling !== null
        && (sampling as { capture_enabled?: unknown }).capture_enabled === true
        && (sampling as { sample_rate?: unknown }).sample_rate === expected.sampleRate;
}

function loadUnifiedSdk(): Promise<UnifiedSdk> {
    if (!sdkLoadPromise) {
        sdkLoadPromise = import('@amplitude/unified').catch((error) => {
            sdkLoadPromise = null;
            throw error;
        });
    }
    return sdkLoadPromise;
}

function validateProperties(
    eventName: AnalyticsEvent,
    properties?: Record<string, unknown>,
): AnalyticsProperties {
    const validated: AnalyticsProperties = {};

    for (const propertyName of EVENT_SCHEMAS[eventName]) {
        const value = PROPERTY_VALIDATORS[propertyName](properties?.[propertyName]);
        if (value !== undefined) validated[propertyName] = value;
    }

    return validated;
}

function flushQueue(): void {
    if (!initializedSdk || !identityReady || identityDeliveryBlocked) return;

    while (queuedEvents.length > 0) {
        const event = queuedEvents.shift();
        if (!event) return;
        try {
            initializedSdk.track(event.eventName, event.properties);
        } catch {
            // Analytics delivery is best-effort and must not affect product behavior.
        }
    }
}

function enqueue(eventName: AnalyticsEvent, properties: AnalyticsProperties): void {
    if (queuedEvents.length === MAX_QUEUED_EVENTS) queuedEvents.shift();
    queuedEvents.push({ eventName, identityRevision, properties });
}

function pruneQueuedEventsForCurrentIdentity(): void {
    let nextIndex = 0;
    for (const event of queuedEvents) {
        if (event.identityRevision !== identityRevision) continue;
        queuedEvents[nextIndex] = event;
        nextIndex += 1;
    }
    queuedEvents.length = nextIndex;
}

function setSdkUserId(sdk: UnifiedSdk, userId: string | undefined): void {
    try {
        sdk.setUserId(userId);
    } catch {
        // Identity updates are best-effort and must not affect analytics startup.
    }
}

function resetSdkIdentity(sdk: UnifiedSdk): boolean {
    try {
        sdk.reset();
        return true;
    } catch {
        setSdkUserId(sdk, undefined);
        return false;
    }
}

function bootIdentityRequiresReset(sdk: UnifiedSdk): boolean {
    try {
        const storedUserId: unknown = sdk.getUserId();
        const readable = storedUserId === undefined || typeof storedUserId === 'string';
        return desiredUserId === undefined || !readable || storedUserId !== desiredUserId;
    } catch {
        return true;
    }
}

function reconcileInitializedIdentity(sdk: UnifiedSdk): boolean {
    if (!hasInspectedSdkIdentity) {
        const bootResetRequired = bootIdentityRequiresReset(sdk);
        pendingIdentityReset = pendingIdentityReset || bootResetRequired;
        hasInspectedSdkIdentity = true;
    }

    if (pendingIdentityReset) {
        pruneQueuedEventsForCurrentIdentity();
        if (!resetSdkIdentity(sdk)) {
            identityDeliveryBlocked = true;
            return false;
        }

        pendingIdentityReset = false;
        identityDeliveryBlocked = false;
        if (desiredUserId !== undefined) setSdkUserId(sdk, desiredUserId);
        identityReconciled = true;
        return true;
    }

    identityDeliveryBlocked = false;
    if (!identityReconciled) {
        identityReconciled = true;
        return true;
    }
    if (desiredUserId !== undefined) setSdkUserId(sdk, desiredUserId);
    return true;
}

type IdentityUpdateResult = 'changed' | 'invalid' | 'unchanged';

function updateResolvedIdentity(userId: string | null): IdentityUpdateResult {
    if (userId !== null && !isCanonicalAnalyticsUserId(userId)) return 'invalid';

    const nextUserId = userId ?? undefined;
    if (hasResolvedIdentity && desiredUserId === nextUserId) return 'unchanged';

    const previousUserId = desiredUserId;
    const hadResolvedIdentity = hasResolvedIdentity;
    desiredUserId = nextUserId;
    hasResolvedIdentity = true;
    identityReady = false;
    if (
        hadResolvedIdentity
        && previousUserId !== undefined
        && previousUserId !== nextUserId
    ) {
        identityRevision += 1;
        pendingIdentityReset = true;
    }
    return 'changed';
}

function createSafeSessionReplayRemoteConfig(apiKey: string) {
    return async function safeSessionReplayRemoteConfig(request: {
    headers: Record<string, string>;
    method: 'GET';
    signal?: AbortSignal;
    url: string;
    }): Promise<Response> {
        const expectedSampling = configuredReplaySampling();
        if (
            !expectedSampling.captureEnabled
            || request.method !== 'GET'
            || !isTrustedReplayConfigUrl(request.url, apiKey)
        ) {
            return replayConfigResponse({ captureEnabled: false, sampleRate: 0 });
        }

        try {
            // Only the SDK's exact Amplitude config request is allowed. Authentication,
            // referrer, cookies, redirects, and every header except the known Accept value
            // are deliberately removed at this boundary.
            const response = await fetch(request.url, {
                method: 'GET',
                headers: { Accept: '*/*' },
                signal: request.signal,
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
            });
            if (
                !response.ok
                || response.redirected
                || response.type === 'opaqueredirect'
                || !hasExpectedReplaySampling(await response.json(), expectedSampling)
            ) {
                return replayConfigResponse({ captureEnabled: false, sampleRate: 0 });
            }
            // Revalidate route, DNT, GPC, environment, and sticky shutdown after the config fetch.
            return configuredReplaySampling().captureEnabled
                ? replayConfigResponse(expectedSampling)
                : replayConfigResponse({ captureEnabled: false, sampleRate: 0 });
        } catch {
            return replayConfigResponse({ captureEnabled: false, sampleRate: 0 });
        }
    };
}

function isTrustedReplayTrackUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const keys = [...url.searchParams.keys()];
        return url.protocol === 'https:'
            && url.hostname === 'api-sr.amplitude.com'
            && url.port === ''
            && url.username === ''
            && url.password === ''
            && url.hash === ''
            && url.pathname === '/sessions/v2/track'
            && keys.length === 3
            && url.searchParams.getAll('device_id').length === 1
            && url.searchParams.getAll('session_id').length === 1
            && url.searchParams.getAll('type').length === 1
            && (url.searchParams.get('device_id')?.length ?? 0) > 0
            && /^\d{10,16}$/.test(url.searchParams.get('session_id') ?? '')
            && url.searchParams.get('type') === 'replay';
    } catch {
        return false;
    }
}

function createSafeSessionReplaySender(apiKey: string) {
    return async function safeSessionReplaySender(request: {
        body: string | Uint8Array;
        headers: Record<string, string>;
        keepalive: boolean;
        method: 'POST';
        url: string;
    }): Promise<Response> {
        if (
            !configuredReplaySampling().captureEnabled
            || request.method !== 'POST'
            || !isTrustedReplayTrackUrl(request.url)
            || request.headers.Authorization !== `Bearer ${apiKey}`
        ) {
            return new Response(null, { status: 204 });
        }

        const headers: Record<string, string> = {
            Accept: '*/*',
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        };
        for (const headerName of [
            'X-Client-Version',
            'X-Client-Library',
            'X-Client-Sample-Rate',
            'X-Sampling-Hash-Alg',
        ]) {
            const value = request.headers[headerName];
            if (typeof value === 'string' && /^[a-zA-Z0-9./_-]{1,100}$/.test(value)) {
                headers[headerName] = value;
            }
        }
        if (
            request.headers['Content-Encoding'] === 'gzip'
            && request.body instanceof Uint8Array
        ) {
            headers['Content-Encoding'] = 'gzip';
        }

        try {
            const body: BodyInit = typeof request.body === 'string'
                ? request.body
                : Uint8Array.from(request.body).buffer;
            return await fetch(request.url, {
                method: 'POST',
                headers,
                body,
                keepalive: request.keepalive,
                credentials: 'omit',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
            });
        } catch {
            return new Response(null, { status: 503 });
        }
    };
}

export function initAmplitude(resolvedUserId: string | null): Promise<boolean> {
    const apiKey = configuredApiKey();
    if (!apiKey) return Promise.resolve(false);
    const identityUpdate = updateResolvedIdentity(resolvedUserId);
    if (identityUpdate === 'invalid') return Promise.resolve(false);
    if (initializedSdk) {
        if (
            identityUpdate === 'unchanged'
            && identityReconciled
            && !identityDeliveryBlocked
            && !pendingIdentityReset
        ) {
            return Promise.resolve(true);
        }
        return Promise.resolve(reconcileInitializedIdentity(initializedSdk));
    }
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
        try {
            const sdk = await loadUnifiedSdk();
            const replaySampling = configuredReplaySampling();
            await sdk.initAll(apiKey, {
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
                    sampleRate: replaySampling.sampleRate,
                    privacyConfig: {
                        defaultMaskLevel: 'conservative',
                        maskSelector: [...SESSION_REPLAY_MASK_SELECTORS],
                        blockSelector: [...SESSION_REPLAY_BLOCK_SELECTORS],
                    },
                    interactionConfig: { enabled: false, batch: false },
                    performanceConfig: { enabled: false },
                    captureDocumentTitle: false,
                    enableUrlChangePolling: false,
                    shouldInlineStylesheet: false,
                    captureAdoptedStyleSheets: false,
                    crossOriginIframes: { enabled: false },
                    storeType: 'memory',
                    handleFetchConfig: createSafeSessionReplayRemoteConfig(apiKey),
                    handleSendEvents: createSafeSessionReplaySender(apiKey),
                },
                engagement: { skip: true },
            });
            initializedSdk = sdk;
            if (
                replayShutdownRequested
                || !configuredReplaySampling().captureEnabled
                || !isReplaySafeLocation()
                || hasReplayPrivacyOptOut()
            ) {
                shutdownSessionReplay();
            }
            const reconciled = reconcileInitializedIdentity(sdk);
            if (reconciled) flushQueue();
            return reconciled;
        } catch {
            return false;
        } finally {
            initializationPromise = null;
        }
    })();

    return initializationPromise;
}

export function trackEvent(
    eventName: AnalyticsEvent,
    properties?: Record<string, unknown>,
): void {
    if (identityDeliveryBlocked || !APPROVED_EVENTS.has(eventName) || !configuredApiKey()) return;

    try {
        enqueue(eventName, validateProperties(eventName, properties));
        if (initializedSdk) {
            flushQueue();
        }
    } catch {
        // Validation and analytics must never interrupt the product flow.
    }
}

export function markAnalyticsIdentityPending(): void {
    identityReady = false;
}

export function markAnalyticsIdentityReady(): void {
    if (identityDeliveryBlocked) return;
    identityReady = true;
    flushQueue();
}

function shutdownSessionReplay(): void {
    replayShutdownRequested = true;
    if (!initializedSdk || replayShutdown) return;
    try {
        initializedSdk.sessionReplay().shutdown();
        replayShutdown = true;
    } catch {
        // Replay must never affect product behavior, including route transitions and HMR.
    }
}

/**
 * This is called on every App Router transition. Once a session enters a sensitive route,
 * capture is stopped rather than trusting a route URL, query, or client-side transition to
 * remain safe. A later navigation requires a fresh page/session before replay can resume.
 */
export function enforceAmplitudeReplayRoutePrivacy(): void {
    if (
        !isReplaySafeLocation()
        || hasReplayPrivacyOptOut()
    ) {
        shutdownSessionReplay();
    }
}

function isSafeNavigationTarget(value: string | URL | null | undefined): boolean {
    if (typeof window === 'undefined' || value === null || value === undefined) return true;
    try {
        const current = new URL(window.location.href);
        const target = new URL(String(value), current);
        return target.origin === current.origin && isReplaySafeLocation({
            hash: target.hash,
            pathname: target.pathname,
            search: target.search,
        });
    } catch {
        return false;
    }
}

export function installAmplitudeReplayNavigationGuards(): () => void {
    if (typeof window === 'undefined') return () => undefined;
    navigationGuardConsumers += 1;

    if (!removeNavigationGuards) {
        const history = window.history;
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        const stopForCurrentLocation = () => enforceAmplitudeReplayRoutePrivacy();

        const guardedPushState: History['pushState'] = function (
            this: History,
            ...args: Parameters<History['pushState']>
        ) {
            if (!isSafeNavigationTarget(args[2])) shutdownSessionReplay();
            return originalPushState.apply(this, args);
        };
        const guardedReplaceState: History['replaceState'] = function (
            this: History,
            ...args: Parameters<History['replaceState']>
        ) {
            if (!isSafeNavigationTarget(args[2])) shutdownSessionReplay();
            return originalReplaceState.apply(this, args);
        };

        history.pushState = guardedPushState;
        history.replaceState = guardedReplaceState;
        window.addEventListener('hashchange', stopForCurrentLocation);
        window.addEventListener('popstate', stopForCurrentLocation);

        removeNavigationGuards = () => {
            if (history.pushState === guardedPushState) history.pushState = originalPushState;
            if (history.replaceState === guardedReplaceState) history.replaceState = originalReplaceState;
            window.removeEventListener('hashchange', stopForCurrentLocation);
            window.removeEventListener('popstate', stopForCurrentLocation);
        };
    }

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        navigationGuardConsumers = Math.max(0, navigationGuardConsumers - 1);
        if (navigationGuardConsumers === 0) {
            removeNavigationGuards?.();
            removeNavigationGuards = null;
        }
    };
}

/** HMR/unmount cleanup; it is idempotent and leaves the explicit product event stream intact. */
export function teardownAmplitudeSessionReplay(): void {
    shutdownSessionReplay();
}

export function isCanonicalAnalyticsUserId(userId: string): boolean {
    return CANONICAL_UUID.test(userId);
}
