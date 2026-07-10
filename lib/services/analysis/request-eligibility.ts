const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

/** Defense in depth for legacy rows; database mutation grants remain the security boundary. */
export function hasValidAnalysisRequestIdempotencyKey(request: {
    idempotency_key?: unknown;
}): boolean {
    return typeof request.idempotency_key === 'string' &&
        IDEMPOTENCY_KEY_PATTERN.test(request.idempotency_key);
}
