import { describe, expect, it } from 'vitest';

import { sanitizeOperationalEvent } from './schema';

const BUSINESS_EVENTS = [
    'auth.callback_completed',
    'auth.profile_sync_failed',
    'preflight.requested',
    'preflight.profile_collected',
    'preflight.completed',
    'preflight.failed',
    'preflight.exclusion_decided',
    'earlybird.checkout_created',
    'earlybird.checkout_failed',
    'groble.webhook_received',
    'groble.webhook_finalized',
    'groble.webhook_rejected',
] as const;

describe('business operational event contract', () => {
    it.each(BUSINESS_EVENTS)('keeps the registered %s event', event => {
        expect(sanitizeOperationalEvent({ event, severity: 'info' }).message).toBe(event);
    });

    it('keeps only registered Groble event types and finalization dispositions', () => {
        const completed = sanitizeOperationalEvent({
            event: 'groble.webhook_finalized',
            severity: 'info',
            fields: {
                webhook_event_type: 'payment.completed',
                disposition: 'accepted',
            },
        });
        const cancellation = sanitizeOperationalEvent({
            event: 'groble.webhook_finalized',
            severity: 'warn',
            fields: {
                webhook_event_type: 'payment.cancel_requested',
                disposition: 'cancel_mismatch',
            },
        });
        const unknown = sanitizeOperationalEvent({
            event: 'groble.webhook_finalized',
            severity: 'warn',
            fields: {
                webhook_event_type: 'buyer.private_event',
                disposition: 'buyer_private_disposition',
            },
        });

        expect(completed.fields).toMatchObject({
            webhook_event_type: 'payment.completed',
            disposition: 'accepted',
        });
        expect(cancellation.fields).toMatchObject({
            webhook_event_type: 'payment.cancel_requested',
            disposition: 'cancel_mismatch',
        });
        expect(unknown.fields).not.toHaveProperty('webhook_event_type');
        expect(unknown.fields).not.toHaveProperty('disposition');
    });

    it('drops payment and identity evidence while preserving safe checkout dimensions', () => {
        const sanitized = sanitizeOperationalEvent({
            event: 'earlybird.checkout_created',
            severity: 'info',
            fields: {
                user_id: '123e4567-e89b-42d3-a456-426614174000',
                preflight_id: '123e4567-e89b-42d3-a456-426614174001',
                order_id: '123e4567-e89b-42d3-a456-426614174002',
                target_instagram_id: 'Target.Account',
                plan_id: 'standard',
                amount_krw: 19_900,
                buyer_email: 'private@example.com',
                buyer_phone: '010-1234-5678',
                buyer_name: 'Private Buyer',
                payment_id: 'merchant-private',
                product_id: 'product-private',
                idempotency_key: 'delivery-private',
                signature: 'signature-private',
                raw_body: 'body-private',
            },
        });

        expect(sanitized.fields).toMatchObject({
            user_id: '123e4567-e89b-42d3-a456-426614174000',
            preflight_id: '123e4567-e89b-42d3-a456-426614174001',
            order_id: '123e4567-e89b-42d3-a456-426614174002',
            target_instagram_id: 'target.account',
            plan_id: 'standard',
            amount_krw: 19_900,
        });
        expect(JSON.stringify(sanitized)).not.toMatch(
            /private@example|010-1234|Private Buyer|merchant-private|product-private|delivery-private|signature-private|body-private/
        );
    });
});
