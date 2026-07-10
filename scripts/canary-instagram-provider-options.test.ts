import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    canaryRelationshipCallLimit,
    callCanaryRelationshipProvider,
    CanaryRelationshipResultError,
    parseCanaryDeclaredCount,
    parseCanaryRelationship,
    requireCanaryRelationshipRows,
    shouldRunCanaryRelationship,
} from './canary-instagram-provider-options';
import { sanitizeCanaryError } from './canary-instagram-provider-errors';
import type { ProviderCallContext, ScraperProvider } from '../lib/services/instagram/providers/types';

function runCanaryWithoutCredentials(
    relationship?: 'followers' | 'following',
    provider: 'apify' | 'flashapi' = 'apify'
) {
    return spawnSync(
        process.execPath,
        [
            '--import',
            'tsx',
            join(process.cwd(), 'scripts/canary-instagram-provider.ts'),
            '--provider',
            provider,
            '--username',
            'canary_test',
            ...(relationship ? ['--relationship', relationship] : []),
            '--limit',
            '1',
            '--confirm-paid-api-call',
        ],
        {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
                ...process.env,
                APIFY_API_TOKEN: '',
                FLASHAPI_RAPIDAPI_KEY: '',
                RAPIDAPI_KEY: '',
            },
        }
    );
}

function outputSteps(stdout: string): string[] {
    return stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { step: string })
        .map((entry) => entry.step);
}

describe('Instagram provider canary relationship selection', () => {
    it('defaults to both and rejects unknown values', () => {
        expect(parseCanaryRelationship(undefined)).toBe('both');
        expect(parseCanaryRelationship('followers')).toBe('followers');
        expect(parseCanaryRelationship('following')).toBe('following');
        expect(parseCanaryRelationship('both')).toBe('both');
        expect(parseCanaryRelationship('invalid')).toBeNull();
    });

    it('parses declared relationship counts without accepting malformed values', () => {
        expect(parseCanaryDeclaredCount(undefined)).toBeUndefined();
        expect(parseCanaryDeclaredCount('0')).toBe(0);
        expect(parseCanaryDeclaredCount('642')).toBe(642);
        expect(parseCanaryDeclaredCount('-1')).toBeNull();
        expect(parseCanaryDeclaredCount('1.5')).toBeNull();
        expect(parseCanaryDeclaredCount('not-a-count')).toBeNull();
    });

    it('selects only the requested relationship', () => {
        expect(shouldRunCanaryRelationship('followers', 'followers')).toBe(true);
        expect(shouldRunCanaryRelationship('followers', 'following')).toBe(false);
        expect(shouldRunCanaryRelationship('following', 'followers')).toBe(false);
        expect(shouldRunCanaryRelationship('following', 'following')).toBe(true);
        expect(shouldRunCanaryRelationship('both', 'followers')).toBe(true);
        expect(shouldRunCanaryRelationship('both', 'following')).toBe(true);
    });

    it('uses the bounded expected count for each relationship provider call', async () => {
        const getFollowers = vi.fn(async () => []);
        const getFollowing = vi.fn(async () => []);
        const provider: ScraperProvider = {
            name: 'apify',
            getFollowers,
            getFollowing,
        };
        const context: ProviderCallContext = { recordUsage: vi.fn() };

        await callCanaryRelationshipProvider(
            provider,
            'canary_test',
            'followers',
            1_000,
            474,
            context
        );
        await callCanaryRelationshipProvider(
            provider,
            'canary_test',
            'following',
            1_000,
            642,
            context
        );

        expect(getFollowers).toHaveBeenCalledWith('canary_test', 474, context);
        expect(getFollowing).toHaveBeenCalledWith('canary_test', 642, context);
    });

    it('falls back to the CLI limit while preserving an expected count of zero', () => {
        expect(canaryRelationshipCallLimit(100)).toBe(100);
        expect(canaryRelationshipCallLimit(1_000, 0)).toBe(0);
        expect(canaryRelationshipCallLimit(500, 642)).toBe(500);
    });

    it.each(['followers', 'following'] as const)(
        'starts only the %s operation in the CLI',
        (relationship) => {
            const result = runCanaryWithoutCredentials(relationship);

            // Missing credentials force a configuration failure before any actor/network call.
            expect(result.status).toBe(1);
            expect(outputSteps(result.stdout)).toEqual([relationship, 'overall']);
        }
    );

    it('starts both operations when --relationship is omitted', () => {
        const result = runCanaryWithoutCredentials();

        expect(result.status).toBe(1);
        expect(outputSteps(result.stdout)).toEqual(['followers', 'following', 'overall']);
    });

    it('uses the production Flash provider path without a separate lookup step', () => {
        const result = runCanaryWithoutCredentials('followers', 'flashapi');

        expect(result.status).toBe(1);
        expect(outputSteps(result.stdout)).toEqual(['followers', 'overall']);
        expect(result.stdout).not.toContain('user_id_lookup');
    });

    it('fails closed when a selected paid canary relationship returns no rows', () => {
        expect(() => requireCanaryRelationshipRows([])).toThrow('CANARY_EMPTY_RELATIONSHIP_RESULT');
        expect(() => requireCanaryRelationshipRows([{
            username: 'one',
            isPrivate: false,
            isVerified: false,
        }])).not.toThrow();
        expect(sanitizeCanaryError(new Error(
            'SCRAPING_INCOMPLETE_ERROR: CANARY_EMPTY_RELATIONSHIP_RESULT'
        ))).toMatchObject({
            category: 'incomplete',
            code: 'provider_empty_result',
        });
    });

    it('uses the same 99% declared-count coverage gate as production', () => {
        const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
            username: `user_${index}`,
            isPrivate: false,
            isVerified: false,
        }));

        expect(() => requireCanaryRelationshipRows(rows(320), 474)).toThrow('INCOMPLETE');
        expect(() => requireCanaryRelationshipRows(rows(425), 642)).toThrow('INCOMPLETE');
        expect(() => requireCanaryRelationshipRows(rows(470), 474)).not.toThrow();
        expect(() => requireCanaryRelationshipRows([], 0)).not.toThrow();
    });

    it('preserves partial rows when completeness rejects a provider result', () => {
        const rows = [{ username: 'one', isPrivate: false, isVerified: false }];
        const original = new Error('SCRAPING_INCOMPLETE_ERROR: short result');
        const wrapped = new CanaryRelationshipResultError(original, rows);

        expect(wrapped.rows).toEqual(rows);
        expect(wrapped.originalError).toBe(original);
        expect(sanitizeCanaryError(wrapped)).toMatchObject({
            category: 'incomplete',
            code: 'provider_result_incomplete',
        });
    });

    it('requires declared counts before a full paid canary can start', () => {
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                join(process.cwd(), 'scripts/canary-instagram-provider.ts'),
                '--provider',
                'flashapi',
                '--username',
                'canary_test',
                '--limit',
                '1000',
                '--confirm-full-paid-api-call',
            ],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    FLASHAPI_RAPIDAPI_KEY: '',
                    RAPIDAPI_KEY: '',
                },
            }
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('invalid_arguments');
        expect(result.stderr).toContain('full canary requires');
    });

    it('accepts the selected declared count before reaching provider credentials', () => {
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                join(process.cwd(), 'scripts/canary-instagram-provider.ts'),
                '--provider',
                'apify',
                '--username',
                'canary_test',
                '--relationship',
                'following',
                '--following-count',
                '642',
                '--limit',
                '1000',
                '--confirm-full-paid-api-call',
            ],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    APIFY_API_TOKEN: '',
                },
            }
        );

        expect(result.status).toBe(1);
        expect(outputSteps(result.stdout)).toEqual(['following', 'overall']);
        expect(result.stderr).toContain('provider_configuration_invalid');
        expect(result.stderr).not.toContain('full canary requires');
    });
});

describe('Instagram provider canary error sanitization', () => {
    it.each([
        ['APIFY_DATASET_TRANSPORT_EXHAUSTED', 'transport', 'dataset_transport_exhausted'],
        ['APIFY_DATASET_OFFSET_MISMATCH', 'incomplete', 'dataset_offset_mismatch'],
        ['APIFY_DATASET_COUNT_MISMATCH', 'incomplete', 'dataset_count_mismatch'],
        ['APIFY_DATASET_TOTAL_CHANGED', 'incomplete', 'dataset_total_changed'],
        ['APIFY_DATASET_TOTAL_LAGGING', 'incomplete', 'dataset_total_lagging'],
        ['APIFY_DATASET_PAGE_EMPTY', 'incomplete', 'dataset_page_empty'],
        ['APIFY_DATASET_LIMIT_EXCEEDED', 'schema', 'dataset_limit_exceeded'],
        ['APIFY_DATASET_READ_INCOMPLETE', 'incomplete', 'dataset_read_incomplete'],
        ['APIFY_RESULT_LIMIT_EXCEEDED', 'schema', 'provider_result_limit_exceeded'],
    ])('maps stable token %s', (token, category, code) => {
        expect(sanitizeCanaryError(new Error(`provider error: ${token}`))).toMatchObject({
            category,
            code,
        });
    });

    it('keeps generic schema, incomplete, and provider fallbacks', () => {
        expect(sanitizeCanaryError(new Error('SCRAPING_SCHEMA_ERROR: unknown')).code)
            .toBe('provider_schema_invalid');
        expect(sanitizeCanaryError(new Error('SCRAPING_INCOMPLETE_ERROR: unknown')).code)
            .toBe('provider_result_incomplete');
        expect(sanitizeCanaryError(new Error('unknown')).code)
            .toBe('provider_operation_failed');
    });
});
