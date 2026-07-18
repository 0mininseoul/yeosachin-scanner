import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    buildAuthProfilePatch,
    type AuthProfileSource,
} from './auth-profile';

describe('buildAuthProfilePatch', () => {
    it('stores trimmed raw and canonical phone numbers together', () => {
        expect(buildAuthProfilePatch({
            phoneNumber: ['  +82 10-1234-5678  '],
        })).toEqual({
            phone_number: '+82 10-1234-5678',
            phone_number_normalized: '+821012345678',
        });
    });

    it.each([
        { phoneNumber: ['010-12-34'] },
        { phoneNumber: ['   '] },
        {},
    ] satisfies AuthProfileSource[])(
        'omits both phone fields for an invalid or absent phone',
        source => {
            const patch = buildAuthProfilePatch(source);

            expect(patch).not.toHaveProperty('phone_number');
            expect(patch).not.toHaveProperty('phone_number_normalized');
        }
    );

    it('uses ordered fallbacks, trims strings, and coerces a numeric birthyear', () => {
        expect(buildAuthProfilePatch({
            name: [null, '   ', '  Account Name  ', 'Ignored Name'],
            nickname: [undefined, '  Nickname  '],
            profileImage: ['', '  https://example.com/avatar.jpg  '],
            gender: [false, '  female  '],
            birthyear: [null, 1997],
            phoneNumber: ['not-a-phone', '  010-9876-5432  '],
        })).toEqual({
            name: 'Account Name',
            nickname: 'Nickname',
            profile_image: 'https://example.com/avatar.jpg',
            gender: 'female',
            birthyear: '1997',
            phone_number: '010-9876-5432',
            phone_number_normalized: '+821098765432',
        });
    });

    it('never copies email or provider into the profile patch', () => {
        const sourceWithForbiddenKeys = {
            name: ['  Kakao User  '],
            email: 'private@example.com',
            provider: 'kakao',
        } as AuthProfileSource & Record<'email' | 'provider', unknown>;

        const patch = buildAuthProfilePatch(sourceWithForbiddenKeys);

        expect(patch).toEqual({ name: 'Kakao User' });
        expect(patch).not.toHaveProperty('email');
        expect(patch).not.toHaveProperty('provider');
    });
});

describe('auth button provider compatibility contract', () => {
    const source = readFileSync(
        new URL('../../../components/auth-buttons.tsx', import.meta.url),
        'utf8'
    );

    it('renders no Google sign-in action', () => {
        expect(source).not.toMatch(/onClick=\{\(\) => signIn\('google'\)\}/);
        expect(source).not.toContain('Google\ub85c');
    });

    it('keeps Google in the internal provider union for legacy compatibility', () => {
        expect(source).toContain("provider: 'kakao' | 'google'");
    });
});

describe('auth profile integration contract', () => {
    const callbackSource = readFileSync(
        new URL('../../../app/auth/callback/route.ts', import.meta.url),
        'utf8'
    );
    const meRouteSource = readFileSync(
        new URL('../../../app/api/user/me/route.ts', import.meta.url),
        'utf8'
    );

    it('maps Kakao REST profile fallbacks through the shared helper', () => {
        expect(callbackSource).toContain('buildAuthProfilePatch({');
        expect(callbackSource).toMatch(
            /name:\s*\[account\.name,\s*profile\.nickname\]/
        );
        expect(callbackSource).toMatch(
            /profileImage:\s*\[profile\.profile_image_url,\s*profile\.thumbnail_image_url\]/
        );
        expect(callbackSource).toMatch(/phoneNumber:\s*\[account\.phone_number\]/);
    });

    it('keeps Kakao profile values and the provider token out of logs', () => {
        const logCalls = callbackSource.match(
            /console\.(?:error|log|warn)\([^;]*\);/g
        ) ?? [];

        expect(logCalls.join('\n')).not.toMatch(
            /\b(?:providerToken|data|account|profilePatch)\b|error\.message/
        );
    });

    it('maps Supabase social metadata fallbacks through the shared helper', () => {
        expect(meRouteSource).toContain('buildAuthProfilePatch({');
        expect(meRouteSource).toMatch(/name:\s*\[m\.name,\s*m\.full_name\]/);
        expect(meRouteSource).toMatch(
            /nickname:\s*\[m\.nickname,\s*m\.preferred_username,\s*m\.user_name,\s*m\.name\]/
        );
        expect(meRouteSource).toMatch(
            /profileImage:\s*\[m\.avatar_url,\s*m\.picture,\s*m\.profile_image\]/
        );
        expect(meRouteSource).toMatch(
            /phoneNumber:\s*\[user\.phone,\s*m\.phone_number,\s*m\.phone\]/
        );
        expect(meRouteSource).toMatch(
            /birthyear:\s*\[m\.birthyear,\s*m\.birth_year\]/
        );
    });
});
