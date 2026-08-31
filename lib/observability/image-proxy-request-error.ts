type ErrorLike = {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
};

function nestedErrorMessage(value: unknown, depth = 0): string {
    if (depth > 3 || value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return '';
    const candidate = value as ErrorLike;
    return [
        typeof candidate.code === 'string' ? candidate.code : '',
        typeof candidate.name === 'string' ? candidate.name : '',
        typeof candidate.message === 'string' ? candidate.message : '',
        nestedErrorMessage(candidate.cause, depth + 1),
    ].filter(Boolean).join(' ');
}

export function isEpipeError(error: unknown): boolean {
    return /(?:^|\b)EPIPE(?:\b|$)/i.test(nestedErrorMessage(error));
}

/**
 * Route-local image delivery noise is benign only after this request's client
 * has disconnected. Other server/provider EPIPEs remain actionable.
 */
export function isImageProxyClientDisconnectEpipe(
    error: unknown,
    signal: AbortSignal,
): boolean {
    return signal.aborted && isEpipeError(error);
}

/**
 * Next's global request-error hook does not expose the response signal. Keep
 * this exact route/method boundary so only its post-disconnect EPIPE is
 * suppressed; callers must pass route metadata, never raw request details.
 */
export function isBenignImageProxyRequestError(input: {
    error: unknown;
    method: string | undefined;
    routePath: string | undefined;
}): boolean {
    return input.method === 'GET'
        && input.routePath === '/api/image-proxy'
        && isEpipeError(input.error);
}
