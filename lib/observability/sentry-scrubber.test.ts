import { describe, expect, it } from 'vitest';
import { scrubSentryEvent } from './sentry-scrubber';

describe('Sentry privacy scrubber', () => {
    it('removes request/user PII and recursively redacts secrets from events and breadcrumbs', () => {
        const webhook = 'https://discord.com/api/webhooks/123/very-secret';
        const result = scrubSentryEvent({
            type: undefined,
            message: 'login user@example.com Bearer top-secret',
            user: { id: '123e4567-e89b-42d3-a456-426614174000', email: 'user@example.com' },
            request: { url: 'https://example.test/?token=top-secret', headers: { authorization: 'Bearer top-secret' } },
            extra: { password: 'nope' },
            contexts: { custom: { birthyear: '1994' } },
            breadcrumbs: [{
                category: 'fetch',
                message: `sent ${webhook} for user@example.com`,
                data: {
                    cookie: 'session=secret',
                    profile_image: 'https://instagram.com/private/image.jpg',
                    nested: { authorization: 'Bearer secret', phone: '010-1234-5678' },
                },
            }],
            exception: { values: [{ type: 'Error', value: 'failed user@example.com 1994-01-02' }] },
        });
        const serialised = JSON.stringify(result);

        expect(result?.user).toBeUndefined();
        expect(result?.request).toBeUndefined();
        expect(result?.extra).toBeUndefined();
        expect(result?.contexts).toBeUndefined();
        expect(serialised).not.toContain('user@example.com');
        expect(serialised).not.toContain('top-secret');
        expect(serialised).not.toContain('010-1234-5678');
        expect(serialised).not.toContain('1994-01-02');
        expect(serialised).not.toContain(webhook);
        expect(serialised).not.toContain('instagram.com');
        expect(serialised).not.toContain('423e4567-e89b-42d3-a456-426614174000');
    });
});
