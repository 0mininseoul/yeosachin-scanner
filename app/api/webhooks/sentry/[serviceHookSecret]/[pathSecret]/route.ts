import { NextResponse } from 'next/server';
import {
    enqueueSentryDiscordAlert,
    isAuthenticSentryServiceHookPath,
    parseProductionSentryIssueAlert,
} from '@/lib/services/sentry-discord-alert';

export const runtime = 'nodejs';

/**
 * The clear stable prefix is /api/webhooks/sentry. Service Hooks do not have a
 * documented delivery signature, so both configured path capabilities are
 * required after that prefix. This handler never logs or reports payloads.
 */
export async function POST(
    request: Request,
    context: { params: Promise<{ serviceHookSecret: string; pathSecret: string }> },
): Promise<NextResponse> {
    const { serviceHookSecret, pathSecret } = await context.params;
    if (!isAuthenticSentryServiceHookPath(serviceHookSecret, pathSecret)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rawBody = await request.text();
    const alert = parseProductionSentryIssueAlert(rawBody, request);
    if (!alert) return NextResponse.json({ accepted: false }, { status: 202 });

    try {
        await enqueueSentryDiscordAlert(alert);
    } catch {
        // Do not throw: throwing would let Next/Sentry ingest the sensitive body.
        // A retryable status asks Sentry to retry only before durable persistence.
        return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503 });
    }
    return NextResponse.json({ accepted: true }, { status: 202 });
}
