import { NextResponse } from 'next/server';
import {
    dispatchSentryDiscordAlertImmediately,
    enqueueSentryDiscordAlert,
    isAuthenticSentryInternalIntegration,
    parseProductionSentryInternalIntegrationIssue,
    sentryDiscordAlertsEnabled,
} from '@/lib/services/sentry-discord-alert';

export const runtime = 'nodejs';

/**
 * Fixed Internal Integration endpoint: Sentry authenticates every delivery
 * using its Client Secret, so no secret is exposed in the configured URL.
 */
export async function POST(request: Request): Promise<NextResponse> {
    const rawBody = await request.text();
    if (!isAuthenticSentryInternalIntegration(request, rawBody)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const alert = parseProductionSentryInternalIntegrationIssue(rawBody);
    if (!alert) return NextResponse.json({ accepted: false }, { status: 202 });
    if (!sentryDiscordAlertsEnabled()) {
        return NextResponse.json({ accepted: false, disabled: true }, { status: 202 });
    }

    try {
        await enqueueSentryDiscordAlert(alert);
    } catch {
        return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503 });
    }
    try {
        await dispatchSentryDiscordAlertImmediately(alert.dedupeKey);
    } catch {
        // The durable enqueue succeeded; never expose or re-ingest the body.
    }
    return NextResponse.json({ accepted: true }, { status: 202 });
}
