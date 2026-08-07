import { describe, expect, it } from 'vitest';

import {
    AUTH_REDIRECT_INTENT_COOKIE,
    AUTH_REDIRECT_INTENT_TTL_SECONDS,
    readOAuthRedirectIntent,
    selectOAuthRedirectIntent,
    serializeOAuthRedirectIntent,
    writeOAuthRedirectIntentCookie,
} from './oauth-redirect-intent';

describe('OAuth redirect intent', () => {
    it('writes a bounded same-site cookie for the browser handoff', () => {
        const writes: string[] = [];

        expect(writeOAuthRedirectIntentCookie(
            '/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=signed',
            value => writes.push(value),
            true,
        )).toBe(true);
        expect(writes).toEqual([
            `${AUTH_REDIRECT_INTENT_COOKIE}=%2Fanalyze%3Fpreflight%3D223e4567-e89b-42d3-a456-426614174000%26claim%3Dsigned; Max-Age=${AUTH_REDIRECT_INTENT_TTL_SECONDS}; Path=/; SameSite=Lax; Secure`,
        ]);
    });

    it('rejects external or control-character redirect intents', () => {
        expect(serializeOAuthRedirectIntent('https://attacker.example')).toBeNull();
        expect(serializeOAuthRedirectIntent('//attacker.example')).toBeNull();
        expect(serializeOAuthRedirectIntent('/analyze\nSet-Cookie:evil=1')).toBeNull();
    });

    it('reads the internal intent and prefers it over a provider-collapsed root', () => {
        const cookie = 'other=1; auth_redirect_intent=%2Fanalyze%3Fautostart%3D1; theme=dark';
        const intent = readOAuthRedirectIntent(cookie);

        expect(intent).toBe('/analyze?autostart=1');
        expect(selectOAuthRedirectIntent('/', intent)).toBe('/analyze?autostart=1');
        expect(selectOAuthRedirectIntent('/analyze', intent)).toBe('/analyze');
    });

    it('restores the cookie claim when a provider drops it from an analyze destination', () => {
        const claimIntent = '/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=signed&plan=standard&checkout=1';

        expect(selectOAuthRedirectIntent(
            '/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&plan=standard&checkout=1',
            claimIntent,
        )).toBe(claimIntent);
    });

    it('does not inherit a stale claim when the explicit preflight is missing', () => {
        const claimIntent = '/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=signed&plan=standard&checkout=1';

        expect(selectOAuthRedirectIntent('/analyze', claimIntent)).toBe('/analyze');
    });

    it('does not merge a claim across different preflights', () => {
        const claimIntent = '/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=signed&plan=standard&checkout=1';
        const explicit = '/analyze?preflight=323e4567-e89b-42d3-a456-426614174000&plan=standard&checkout=1';

        expect(selectOAuthRedirectIntent(explicit, claimIntent)).toBe(explicit);
    });

    it('keeps an explicit claim authoritative', () => {
        const cookieIntent = '/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=cookie&plan=standard&checkout=1';
        const explicit = '/analyze?preflight=223e4567-e89b-42d3-a456-426614174000&claim=explicit&plan=standard&checkout=1';

        expect(selectOAuthRedirectIntent(explicit, cookieIntent)).toBe(explicit);
    });
});
