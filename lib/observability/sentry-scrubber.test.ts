import { describe, expect, it } from 'vitest';
import {
    scrubSentryEvent,
    scrubSentrySpan,
    scrubSentryTransaction,
} from './sentry-scrubber';

describe('Sentry privacy scrubber', () => {
    it('removes request/user PII and recursively redacts secrets from events and breadcrumbs', () => {
        const webhook = 'https://discord.com/api/webhooks/123/very-secret';
        const result = scrubSentryEvent({
            type: undefined,
            message: 'login user@example.com Basic dXNlcjpwYXNz token=top-secret id_token=eyJhbGciOiJIUzI1Ni.abcde.zyxwv code=oauth-code state=oauth-state code_verifier=oauth-verifier-secret DOB=19940102 birthyear 1994; harmless error code 42',
            user: { id: '123e4567-e89b-42d3-a456-426614174000', email: 'user@example.com' },
            request: { url: 'https://example.test/?token=top-secret', headers: { authorization: 'Bearer top-secret' } },
            extra: { password: 'nope' },
            tags: {
                run_id: 'analysis-run-raw',
                requestId: 'request-raw',
                candidateKey: 'candidate-raw',
                accountIdentifier: 'account-raw',
            },
            contexts: { custom: { birthyear: '1994' } },
            breadcrumbs: [{
                category: 'fetch',
                message: `sent ${webhook} Cookie: sb-access-token=session-secret for user@example.com state=breadcrumb-state DOB=19940102`,
                data: {
                    cookie: 'session=secret',
                    profile_image: 'https://scontent-icn1-1.cdninstagram.com/private/image.jpg',
                    nested: { authorization: 'Digest secret', phone: '010-1234-5678' },
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
        expect(serialised).not.toContain('session-secret');
        expect(serialised).not.toContain('dXNlcjpwYXNz');
        expect(serialised).not.toContain('eyJhbGciOiJIUzI1Ni.abcde.zyxwv');
        expect(serialised).not.toContain('010-1234-5678');
        expect(serialised).not.toContain('1994-01-02');
        expect(serialised).not.toContain(webhook);
        expect(serialised).not.toContain('cdninstagram.com');
        expect(serialised).not.toContain('423e4567-e89b-42d3-a456-426614174000');
        expect(serialised).not.toContain('analysis-run-raw');
        expect(serialised).not.toContain('request-raw');
        expect(serialised).not.toContain('candidate-raw');
        expect(serialised).not.toContain('account-raw');
        expect(serialised).not.toContain('oauth-code');
        expect(serialised).not.toContain('oauth-state');
        expect(serialised).not.toContain('oauth-verifier-secret');
        expect(serialised).not.toContain('breadcrumb-state');
        expect(serialised).not.toContain('19940102');
        expect(serialised).not.toContain('birthyear 1994');
        expect(serialised).toContain('harmless error code 42');
    });

    it('scrubs transaction URL/query attributes and child span descriptions before tracing transport', () => {
        const transaction = scrubSentryTransaction({
            type: 'transaction',
            transaction: '/auth/callback?token=secret&email=user@example.com&code=oauth-code&state=oauth-state',
            request: { url: 'https://example.test/?session=secret' },
            spans: [{
                trace_id: 'a'.repeat(32),
                span_id: 'b'.repeat(16),
                start_timestamp: 1,
                data: {
                    'http.url': 'https://discord.com/api/webhooks/123/secret?thread_id=private',
                    authorization: 'Basic private',
                    analysisRunId: 'analysis-run-raw',
                    preflight_key: 'preflight-raw',
                    targetId: 'target-raw',
                    'http.target': '/auth/callback?code=span-code&code_challenge=challenge&DOB=19940102',
                },
                description: 'GET https://scontent.cdninstagram.com/avatar.jpg?token=private',
            }],
        });
        const span = scrubSentrySpan({
            trace_id: 'c'.repeat(32), span_id: 'd'.repeat(16), start_timestamp: 1,
            data: { 'http.target': '/x?access_token=private&state=span-state', cookie: 'a=b' },
            description: 'birthyear 1994',
        });
        const serialised = JSON.stringify({ transaction, span });

        expect(serialised).not.toContain('secret');
        expect(serialised).not.toContain('user@example.com');
        expect(serialised).not.toContain('discord.com');
        expect(serialised).not.toContain('cdninstagram.com');
        expect(serialised).not.toContain('private');
        expect(serialised).not.toContain('analysis-run-raw');
        expect(serialised).not.toContain('preflight-raw');
        expect(serialised).not.toContain('target-raw');
        expect(serialised).not.toContain('oauth-code');
        expect(serialised).not.toContain('oauth-state');
        expect(serialised).not.toContain('span-code');
        expect(serialised).not.toContain('challenge');
        expect(serialised).not.toContain('span-state');
        expect(serialised).not.toContain('19940102');
        expect(serialised).not.toContain('birthyear 1994');
    });
});
