import { NextResponse } from 'next/server';
import {
    deliverSentryDiscordAlerts,
    enqueueSentryDiscordAlert,
    isAuthenticSentryServiceHook,
    parseProductionSentryIssueAlert,
} from '@/lib/services/sentry-discord-alert';

export const runtime = 'nodejs';

/**
 * The clear stable prefix is /api/webhooks/sentry. This handler verifies the
 * raw-body Service Hook v0 HMAC plus the configured path capability and never
 * logs or reports payloads.
 */
export async function POST(
    request: Request,
    context: { params: Promise<{ pathSecret: string }> },
): Promise<NextResponse> {
    const { pathSecret } = await context.params;
    const rawBody = await request.text();
    if (!isAuthenticSentryServiceHook(request, rawBody, pathSecret)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const alert = parseProductionSentryIssueAlert(rawBody);
    if (!alert) return NextResponse.json({ accepted: false }, { status: 202 });

    try {
        await enqueueSentryDiscordAlert(alert);
    } catch {
        // Do not throw: throwing would let Next/Sentry ingest the sensitive body.
        // A retryable status asks Sentry to retry only before durable persistence.
        return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503 });
    }
    // A Vercel Free cron can be daily. Try one bounded delivery while this
    // authenticated request is alive; failures are recorded and still return 202.
    try {
        await deliverSentryDiscordAlerts({ limit: 1 });
    } catch {
        // Durable enqueue already succeeded. Never turn a Discord dispatcher
        // defect into a non-2xx Service Hook response.
    }
    return NextResponse.json({ accepted: true }, { status: 202 });
}
