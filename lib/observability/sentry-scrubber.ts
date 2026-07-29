import type { SpanJSON, TransactionEvent } from '@sentry/core';
import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs';

const REDACTED = '[Filtered]';
const SENSITIVE_KEY = /(?:pass(?:word)?|otp|authorization(?:[_-]?code)?|code(?:[_-]?(?:verifier|challenge))?|state|cookie|token|secret|session|email|e-?mail|phone|birth(?:year|date)?|user[_-]?id|account[_-]?id|(?:analysis|candidate|target|preflight|suspect)[_-]?(?:id|key|run)?|run[_-]?id|request[_-]?id|instagram|profile(?:[_-]?image)?|webhook|supabase|discord)/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE = /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu;
const BIRTHDATE = /\b(?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01])\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const AUTHORIZATION_VALUE = /\b(?:authorization\s*[:=]\s*)?(?:basic|bearer|digest|hmac|negotiate|token|apikey)\s+[^\s,;]+/giu;
const SECRET_VALUE = /(?:\b(?:access|refresh|provider|id|service)[_-]?(?:token|key)|\b(?:api[_-]?key|password|otp|secret|session(?:[_-]?(?:id|key))?|supabase(?:[_-]?(?:key|token))?))\s*[:=]\s*[^\s,;]+/giu;
const COOKIE_VALUE = /\b(?:set[-_ ]?cookie|cookie(?:2)?)\s*[:=]\s*[^\n;]+(?:;[^\n]*)?/giu;
const QUERY_SECRET = /([?&](?:[^=&\s]*?(?:token|session|cookie|authorization|password|otp|secret|key|email|phone|dob|birth(?:year|date)?|code(?:[_-]?(?:verifier|challenge))?|state|user(?:[_-]?id)?|account(?:[_-]?id)?)[^=&\s]*)=)[^&#\s]*/giu;
const BARE_SECRET_ASSIGNMENT = /(\b(?:access[_-]?token|refresh[_-]?token|provider[_-]?token|id[_-]?token|service[_-]?key|supabase[_-]?(?:key|token)|token|session|cookie|authorization(?:[_-]?code)?|password|otp|secret|api[_-]?key|code(?:[_-]?(?:verifier|challenge))?|state|dob)=)[^\s&#,;]*/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu;
const COMPACT_BIRTHDATE = /\b(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b/g;
const CONTEXTUAL_BIRTHYEAR = /\b(?:birth[_ ]?year|dob)\s*[:=]?\s*(?:19|20)\d{2}\b/giu;
const DISCORD_WEBHOOK_URL = /https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"']+/giu;
const DISCORD_API_URL = /https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/v\d+\/channels\/[^\s"']+/giu;
const SENTRY_SERVICE_HOOK_URL = /https?:\/\/[^\s"']+\/api\/webhooks\/sentry\/[^\s/?#"']+(?:\?[^\s"']*)?/giu;
const INSTAGRAM_URL = /https?:\/\/[^\s"']*(?:instagram\.com|cdninstagram\.com|fbcdn\.net)[^\s"']*/giu;

function isExternalWebKitBridgeError(event: ErrorEvent): boolean {
    return event.exception?.values?.some(exception =>
        exception.value?.includes('window.webkit.messageHandlers')
        && exception.stacktrace?.frames?.some(frame =>
            frame.filename?.startsWith('app:///')
            && frame.function === 'sendDataToNative'
        )
    ) ?? false;
}

function scrubString(value: string): string {
    return value
        .replace(DISCORD_WEBHOOK_URL, REDACTED)
        .replace(DISCORD_API_URL, REDACTED)
        .replace(SENTRY_SERVICE_HOOK_URL, REDACTED)
        .replace(INSTAGRAM_URL, REDACTED)
        .replace(COOKIE_VALUE, REDACTED)
        .replace(AUTHORIZATION_VALUE, REDACTED)
        .replace(QUERY_SECRET, '$1[Filtered]')
        .replace(BARE_SECRET_ASSIGNMENT, '$1[Filtered]')
        .replace(JWT, REDACTED)
        .replace(EMAIL, REDACTED)
        .replace(PHONE, REDACTED)
        .replace(BIRTHDATE, REDACTED)
        .replace(COMPACT_BIRTHDATE, REDACTED)
        .replace(CONTEXTUAL_BIRTHYEAR, REDACTED)
        .replace(UUID, REDACTED)
        .replace(SECRET_VALUE, REDACTED);
}

function scrubValue(value: unknown, depth = 0): unknown {
    if (depth > 8) return REDACTED;
    if (typeof value === 'string') return scrubString(value);
    if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1));
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([key]) => !SENSITIVE_KEY.test(key))
            .map(([key, child]) => [key, scrubValue(child, depth + 1)]),
    );
}

/**
 * A deny-by-default privacy boundary shared by browser, Node, and edge Sentry SDKs.
 * Automatic request/user data is removed before transport; recursively scrubbed values
 * cover exception messages and manually-added breadcrumbs as a second line of defense.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent | null {
    // This originates in a native WebView bridge outside the served application.
    // Drop only the exact bridge signature so it cannot create noisy dev issues.
    if (isExternalWebKitBridgeError(event)) return null;

    const sanitized = scrubValue(event) as ErrorEvent;
    delete sanitized.user;
    delete sanitized.request;
    delete sanitized.extra;
    delete sanitized.contexts;
    delete sanitized.sdkProcessingMetadata;

    if (sanitized.breadcrumbs) {
        sanitized.breadcrumbs = sanitized.breadcrumbs.map(breadcrumb => ({
            ...breadcrumb,
            data: scrubValue(breadcrumb.data) as Record<string, unknown> | undefined,
            message: breadcrumb.message ? scrubString(breadcrumb.message) : undefined,
        }));
    }
    return sanitized;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
    return {
        ...breadcrumb,
        data: scrubValue(breadcrumb.data) as Record<string, unknown> | undefined,
        message: breadcrumb.message ? scrubString(breadcrumb.message) : undefined,
    };
}

function scrubTraceEvent<T extends TransactionEvent>(event: T): T {
    const sanitized = scrubValue(event) as T;
    delete sanitized.user;
    delete sanitized.request;
    delete sanitized.extra;
    delete sanitized.contexts;
    delete sanitized.sdkProcessingMetadata;
    if (sanitized.transaction) sanitized.transaction = scrubString(sanitized.transaction);
    if (sanitized.spans) sanitized.spans = sanitized.spans.map(scrubSentrySpan);
    return sanitized;
}

/** Transactions have their own SDK pipeline and must not bypass request URL filtering. */
export function scrubSentryTransaction(event: TransactionEvent): TransactionEvent | null {
    return scrubTraceEvent(event);
}

/** Span attributes frequently contain HTTP URLs and request identifiers. */
export function scrubSentrySpan(span: SpanJSON): SpanJSON {
    const sanitized = scrubValue(span) as SpanJSON;
    if (sanitized.description) sanitized.description = scrubString(sanitized.description);
    sanitized.data = scrubValue(sanitized.data) as SpanJSON['data'];
    return sanitized;
}
