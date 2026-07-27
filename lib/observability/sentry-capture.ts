import * as Sentry from '@sentry/nextjs';

/** Client error boundaries must never replace the user-facing fallback with telemetry failure. */
export function captureExceptionSafely(error: unknown): void {
    try {
        Sentry.captureException(error);
    } catch {
        // Sentry is optional telemetry.
    }
}
