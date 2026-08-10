export type ShareObservationChannel = 'clipboard' | 'web_share' | 'kakao';
export type ShareObservationOutcome = 'started' | 'succeeded' | 'cancelled' | 'failed' | 'confirmed' | 'opened';

export const SHARE_OBSERVATION_EVENTS = Object.freeze({
    initiated: 'result_share_initiated',
    copySucceeded: 'result_share_copy_succeeded',
    handoffCompleted: 'result_share_handoff_completed',
    confirmed: 'result_shared_confirmed',
    opened: 'shared_result_opened',
    cancelled: 'result_share_cancelled',
    failed: 'result_share_failed',
} as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export interface ShareObservationInput {
    readonly requestId: string;
    readonly channel: ShareObservationChannel;
    readonly outcome: ShareObservationOutcome;
    readonly clientNonce: string;
}

export interface ShareObservationEvent {
    readonly event: string;
    readonly requestId: string;
    readonly shareChannel: ShareObservationChannel;
    readonly shareOutcome: ShareObservationOutcome;
}

export class ShareObservationError extends Error {
    constructor(readonly code: 'INVALID_INPUT' | 'SEMANTIC_MISMATCH') {
        super(`SHARE_OBSERVATION_${code}`);
        this.name = 'ShareObservationError';
    }
}

export function shareObservationEvent(input: ShareObservationInput): ShareObservationEvent {
    if (
        !UUID.test(input.requestId)
        || !['clipboard', 'web_share', 'kakao'].includes(input.channel)
        || !['started', 'succeeded', 'cancelled', 'failed', 'confirmed', 'opened'].includes(input.outcome)
        || !NONCE.test(input.clientNonce)
    ) throw new ShareObservationError('INVALID_INPUT');
    if (input.outcome === 'confirmed' && input.channel !== 'kakao') {
        throw new ShareObservationError('SEMANTIC_MISMATCH');
    }
    const event = input.outcome === 'started'
        ? SHARE_OBSERVATION_EVENTS.initiated
        : input.outcome === 'confirmed'
            ? SHARE_OBSERVATION_EVENTS.confirmed
            : input.outcome === 'opened'
                ? SHARE_OBSERVATION_EVENTS.opened
                : input.outcome === 'succeeded' && input.channel === 'clipboard'
                    ? SHARE_OBSERVATION_EVENTS.copySucceeded
                    : input.outcome === 'succeeded' && input.channel === 'web_share'
                        ? SHARE_OBSERVATION_EVENTS.handoffCompleted
                        : input.outcome === 'cancelled'
                            ? SHARE_OBSERVATION_EVENTS.cancelled
                            : SHARE_OBSERVATION_EVENTS.failed;
    return Object.freeze({
        event,
        requestId: input.requestId.toLowerCase(),
        shareChannel: input.channel,
        shareOutcome: input.outcome,
    });
}

export function isShareObservationEvent(value: unknown): value is ShareObservationEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as Record<string, unknown>;
    return typeof event.event === 'string'
        && Object.values(SHARE_OBSERVATION_EVENTS).includes(event.event as never)
        && typeof event.requestId === 'string'
        && UUID.test(event.requestId)
        && typeof event.shareChannel === 'string'
        && typeof event.shareOutcome === 'string';
}
