import { describe, expect, it } from 'vitest';
import {
    profileFetchOutcomeSchema,
    summarizeProfileFetchOutcomes,
    type ProfileFetchOutcome,
} from '../../../../lib/domain/analysis/profile-fetch-outcome';

const capturedAt = '2026-07-13T01:29:07.347Z';

function outcome(
    value: Partial<ProfileFetchOutcome> & Pick<ProfileFetchOutcome, 'requestedUsername' | 'status'>
): ProfileFetchOutcome {
    return profileFetchOutcomeSchema.parse({
        source: 'selfhosted',
        requestCount: 1,
        latencyMs: 900,
        capturedAt,
        failureCategory: null,
        httpStatus: null,
        ...value,
    });
}

describe('profile fetch outcome contract', () => {
    it('keeps every unresolved username and its bounded reason', () => {
        const summary = summarizeProfileFetchOutcomes(
            ['Alice', 'Bob', 'Carol', 'Dave'],
            [
                outcome({ requestedUsername: 'alice', status: 'success' }),
                outcome({
                    requestedUsername: 'bob',
                    status: 'failed',
                    failureCategory: 'rate_limit',
                    httpStatus: 429,
                }),
                outcome({
                    requestedUsername: 'carol',
                    status: 'unavailable',
                    failureCategory: 'not_found',
                    httpStatus: 404,
                }),
                outcome({
                    requestedUsername: 'dave',
                    status: 'failed',
                    failureCategory: 'unknown',
                    httpStatus: null,
                }),
            ]
        );

        expect(summary).toEqual({
            requested: 4,
            succeeded: 1,
            unavailable: 1,
            failed: 2,
            unresolvedUsernames: ['bob', 'carol', 'dave'],
            failureCounts: { rate_limit: 1, not_found: 1, unknown: 1 },
        });
    });

    it('rejects duplicate, unexpected, and malformed outcome usernames', () => {
        const alice = outcome({ requestedUsername: 'alice', status: 'success' });
        expect(() => summarizeProfileFetchOutcomes(['alice', 'Alice'], [alice]))
            .toThrow('duplicate requested username');
        expect(() => summarizeProfileFetchOutcomes(['alice'], [
            outcome({ requestedUsername: 'bob', status: 'success' }),
        ])).toThrow('unexpected outcome username');
        expect(() => summarizeProfileFetchOutcomes(['alice'], [alice, alice]))
            .toThrow('duplicate outcome username');
        expect(() => summarizeProfileFetchOutcomes(['alice', 'bob'], [alice]))
            .toThrow('missing terminal outcome for bob');
    });

    it('does not allow a failed lookup without a failure category', () => {
        expect(() => profileFetchOutcomeSchema.parse({
            requestedUsername: 'alice',
            source: 'selfhosted',
            requestCount: 1,
            latencyMs: 100,
            capturedAt,
            status: 'failed',
            failureCategory: null,
            httpStatus: null,
        })).toThrow();
    });

    it('preserves incomplete provider coverage as a bounded failed outcome', () => {
        expect(profileFetchOutcomeSchema.parse({
            requestedUsername: 'alice',
            source: 'selfhosted',
            requestCount: 1,
            latencyMs: 100,
            capturedAt,
            status: 'failed',
            failureCategory: 'incomplete',
            httpStatus: null,
        })).toMatchObject({
            status: 'failed',
            failureCategory: 'incomplete',
        });
    });
});
