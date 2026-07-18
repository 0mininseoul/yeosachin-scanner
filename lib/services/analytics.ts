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
const SAFE_REPLAY_HTTPS_URL = 'https://yeosachin.vercel.app/';
const SAFE_REPLAY_HTTP_URL = 'http://localhost/';

const SAFE_SESSION_REPLAY_URL_FILTER_RULES = [
    { selector: 'https://*/**', replacement: SAFE_REPLAY_HTTPS_URL },
    { selector: 'http://*/**', replacement: SAFE_REPLAY_HTTP_URL },
];

interface SessionReplaySendRequest {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string | Uint8Array;
    keepalive: boolean;
}

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
    error_code: registeredErrorCodeValidator,
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
    [EVENTS.ANALYSIS_COMPLETED]: ['request_id', 'duration_ms'],
    [EVENTS.RESULT_VIEWED]: ['request_id', 'result_count', 'is_shared'],
    [EVENTS.RESULT_SHARED]: ['request_id', 'share_channel'],
};

interface QueuedEvent {
    eventName: AnalyticsEvent;
    properties: AnalyticsProperties;
}

let identityReady = false;
let initializationPromise: Promise<boolean> | null = null;
let initializingSdk: UnifiedSdk | null = null;
let initializedSdk: UnifiedSdk | null = null;
let sdkLoadPromise: Promise<UnifiedSdk> | null = null;
let desiredUserId: string | undefined;
let hasResolvedIdentity = false;
let identityRevision = 0;
const queuedEvents: QueuedEvent[] = [];

const SAFE_SESSION_REPLAY_REMOTE_CONFIG = {
    configs: {
        sessionReplay: {
            sr_sampling_config: {
                sample_rate: 1,
                capture_enabled: true,
            },
        },
    },
} as const;

function configuredApiKey(): string | null {
    if (typeof window === 'undefined') return null;

    const apiKey = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY?.trim() ?? '';
    if (!API_KEY_PATTERN.test(apiKey) || /^([0-9a-f])\1{31}$/i.test(apiKey)) return null;
    return apiKey;
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
    if (!initializedSdk || !identityReady) return;

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
    queuedEvents.push({ eventName, properties });
}

function setSdkUserId(sdk: UnifiedSdk, userId: string | undefined): void {
    try {
        sdk.setUserId(userId);
    } catch {
        // Identity updates are best-effort and must not affect analytics startup.
    }
}

function updateResolvedIdentity(userId: string | null): boolean {
    if (userId !== null && !isCanonicalAnalyticsUserId(userId)) return false;

    const nextUserId = userId ?? undefined;
    if (hasResolvedIdentity && desiredUserId === nextUserId) return true;

    desiredUserId = nextUserId;
    hasResolvedIdentity = true;
    identityRevision += 1;
    if (initializingSdk) setSdkUserId(initializingSdk, desiredUserId);
    if (initializedSdk) setSdkUserId(initializedSdk, desiredUserId);
    return true;
}

async function safeSessionReplayRemoteConfig(): Promise<Response> {
    return new Response(JSON.stringify(SAFE_SESSION_REPLAY_REMOTE_CONFIG), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

function safeSessionReplayClientUrl(headers: Record<string, string>): string {
    const clientUrl = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === 'x-client-url',
    )?.[1];
    return clientUrl?.startsWith('http://')
        ? SAFE_REPLAY_HTTP_URL
        : SAFE_REPLAY_HTTPS_URL;
}

async function safeSessionReplaySendEvents(
    request: SessionReplaySendRequest,
): Promise<Response> {
    const headers = Object.fromEntries(
        Object.entries(request.headers).filter(
            ([name]) => name.toLowerCase() !== 'x-client-url',
        ),
    );
    headers['X-Client-Url'] = safeSessionReplayClientUrl(request.headers);

    return fetch(request.url, {
        method: request.method,
        headers,
        body: request.body as BodyInit,
        keepalive: request.keepalive,
    });
}

export function initAmplitude(resolvedUserId: string | null): Promise<boolean> {
    const apiKey = configuredApiKey();
    if (!apiKey) return Promise.resolve(false);
    if (!updateResolvedIdentity(resolvedUserId)) return Promise.resolve(false);
    if (initializedSdk) return Promise.resolve(true);
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
        try {
            const sdk = await loadUnifiedSdk();
            initializingSdk = sdk;
            const appliedIdentityRevision = identityRevision;
            setSdkUserId(sdk, desiredUserId);
            await sdk.initAll(apiKey, {
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
                        ugcFilterRules: SAFE_SESSION_REPLAY_URL_FILTER_RULES,
                    },
                    performanceConfig: { enabled: false },
                    captureDocumentTitle: false,
                    enableUrlChangePolling: false,
                    handleFetchConfig: safeSessionReplayRemoteConfig,
                    handleSendEvents: safeSessionReplaySendEvents,
                },
                engagement: { skip: true },
            });
            if (appliedIdentityRevision !== identityRevision) {
                setSdkUserId(sdk, desiredUserId);
            }
            initializedSdk = sdk;
            initializingSdk = null;
            flushQueue();
            return true;
        } catch {
            initializingSdk = null;
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
    if (!APPROVED_EVENTS.has(eventName) || !configuredApiKey()) return;

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
    identityReady = true;
    flushQueue();
}

export function isCanonicalAnalyticsUserId(userId: string): boolean {
    return CANONICAL_UUID.test(userId);
}
