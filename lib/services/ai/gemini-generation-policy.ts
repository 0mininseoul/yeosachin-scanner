export type GeminiGenerationErrorDisposition =
    | 'rate_limited'
    | 'ambiguous'
    | 'rejected';

export const AI_AMBIGUOUS_GENERATION_ERROR_PREFIX =
    'AI_AMBIGUOUS_GENERATION_ERROR:';

export function isAmbiguousGeminiGenerationError(error: unknown): boolean {
    return error instanceof Error
        && error.message.startsWith(AI_AMBIGUOUS_GENERATION_ERROR_PREFIX);
}

const AMBIGUOUS_TRANSPORT_PATTERNS = [
    /\b(?:econnreset|etimedout|eai_again|enotfound)\b/i,
    /\b(?:network|socket)\b/i,
    /\bfetch failed\b/i,
    /\bconnection reset\b/i,
    /\bsocket hang up\b/i,
    /\b(?:timed out|timeout)\b/i,
    /\bdeadline exceeded\b/i,
    /\babort(?:ed|error)?\b/i,
    /\bhttp\s*5\d\d\b/i,
    /\b5\d\d\b/i,
];

const RATE_LIMIT_PATTERNS = [
    /\b429\b/,
    /\brate[ -]?limit(?:ed|ing)?\b/i,
    /\btoo many requests\b/i,
    /\bresource[_ -]?exhausted\b/i,
];

function numericStatus(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) {
        return Number(value);
    }
    return null;
}

function readStatus(error: unknown, depth = 0): number | null {
    if (!error || typeof error !== 'object' || depth > 2) {
        return null;
    }

    const candidate = error as {
        status?: unknown;
        statusCode?: unknown;
        response?: { status?: unknown };
        cause?: unknown;
    };
    return numericStatus(candidate.status)
        ?? numericStatus(candidate.statusCode)
        ?? numericStatus(candidate.response?.status)
        ?? readStatus(candidate.cause, depth + 1);
}

function readMessages(error: unknown, depth = 0): string[] {
    if (depth > 2) return [];
    if (typeof error === 'string') return [error];
    if (!error || typeof error !== 'object') return [];

    const candidate = error as { message?: unknown; cause?: unknown };
    return [
        ...(typeof candidate.message === 'string' ? [candidate.message] : []),
        ...readMessages(candidate.cause, depth + 1),
    ];
}

/**
 * Only an explicit 429 is safe to retry. Transport failures and server errors can
 * arrive after generation started, so retrying them could produce a second charge.
 */
export function classifyGeminiGenerationError(
    error: unknown
): GeminiGenerationErrorDisposition {
    const status = readStatus(error);
    if (status === 429) return 'rate_limited';
    if (status === 408 || (status !== null && status >= 500)) return 'ambiguous';

    const messages = readMessages(error);
    if (messages.some(message => AMBIGUOUS_TRANSPORT_PATTERNS.some(pattern => pattern.test(message)))) {
        return 'ambiguous';
    }
    if (messages.some(message => RATE_LIMIT_PATTERNS.some(pattern => pattern.test(message)))) {
        return 'rate_limited';
    }

    // A concrete non-timeout 4xx response establishes that generation was rejected.
    if (status !== null && status >= 400 && status < 500) return 'rejected';

    // Unknown SDK failures cannot establish whether the service started processing.
    return 'ambiguous';
}
