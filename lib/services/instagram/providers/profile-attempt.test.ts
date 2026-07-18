import { describe, expect, it } from 'vitest';

import { profileAttemptFailureDetails } from './profile-attempt';
import { makeWebProfileFetcher } from './selfhosted/web-client';

describe('profile attempt failure details', () => {
    it('classifies the self-hosted fetcher open circuit as a transport failure', async () => {
        const fetchProfile = makeWebProfileFetcher({
            env: {
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'false',
                SELFHOSTED_PROFILE_RETRIES: '0',
            },
            fetchFn: async () => new Response(null, { status: 429 }),
        });

        await expect(fetchProfile('first.account')).rejects.toThrow('rate limited');

        let circuitError: unknown;
        try {
            await fetchProfile('second.account');
        } catch (error) {
            circuitError = error;
        }

        expect(profileAttemptFailureDetails(circuitError)).toEqual({
            failureCategory: 'transport',
            httpStatus: null,
        });
    });

    it('does not treat an unrelated circuit message as a transport failure', () => {
        expect(profileAttemptFailureDetails(
            new Error('Provider circuit metadata was malformed.')
        )).toEqual({
            failureCategory: 'unknown',
            httpStatus: null,
        });
    });
});
