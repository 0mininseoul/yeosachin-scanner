import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs';

const REDACTED = '[Filtered]';
const SENSITIVE_KEY = /(?:pass(?:word)?|otp|authorization|cookie|token|secret|session|email|e-?mail|phone|birth(?:year|date)?|user[_-]?id|account[_-]?id|instagram|profile(?:[_-]?image)?|webhook|supabase|discord)/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE = /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu;
const BIRTHDATE = /\b(?:19|20)\d{2}[-/.](?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01])\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const SECRET_VALUE = /(?:bearer\s+|(?:access|refresh|provider|service)[_-]?token[=:]\s*|(?:api[_-]?key|password|otp|secret)[=:]\s*)[^\s,;]+/giu;
const DISCORD_WEBHOOK_URL = /https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"']+/giu;
const INSTAGRAM_URL = /https?:\/\/(?:www\.)?instagram\.com\/[^\s"']+/giu;

function scrubString(value: string): string {
    return value
        .replace(DISCORD_WEBHOOK_URL, REDACTED)
        .replace(INSTAGRAM_URL, REDACTED)
        .replace(EMAIL, REDACTED)
        .replace(PHONE, REDACTED)
        .replace(BIRTHDATE, REDACTED)
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
