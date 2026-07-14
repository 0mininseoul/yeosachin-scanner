import { describe, expect, it } from 'vitest';
import {
    AMBIGUOUS_START_CONFIRMATION,
    parseAmbiguousStartOptions,
} from './preflight-ambiguous-start-resolution-options';

const resolveArguments = [
    '--resolve',
    '--preflight-id=00000000-0000-4000-8000-000000000001',
    '--operation-key=target-profile-fallback',
    `--input-hash=${'a'.repeat(64)}`,
    '--logical-provider=apify',
    '--actor-id=apify/instagram-profile-scraper',
    '--credential-slot=quinary',
    '--max-charge-usd=0.002600000000',
    '--reserved-at=2026-07-15T01:02:03.000Z',
    '--evidence-reference-file=/secure/incident-reference.txt',
    `--confirm=${AMBIGUOUS_START_CONFIRMATION}`,
];

describe('ambiguous preflight start resolution CLI options', () => {
    it('defaults to a bounded read-only candidate list', () => {
        expect(parseAmbiguousStartOptions(['--list'])).toEqual({
            mode: 'list',
            limit: 20,
        });
        expect(parseAmbiguousStartOptions(['--list', '--limit', '100'])).toEqual({
            mode: 'list',
            limit: 100,
        });
    });

    it('requires the exact immutable identity and explicit confirmation', () => {
        expect(parseAmbiguousStartOptions(resolveArguments)).toEqual({
            mode: 'resolve',
            preflightId: '00000000-0000-4000-8000-000000000001',
            operationKey: 'target-profile-fallback',
            inputHash: 'a'.repeat(64),
            logicalProvider: 'apify',
            actorId: 'apify/instagram-profile-scraper',
            credentialSlot: 'quinary',
            maxChargeUsd: '0.002600000000',
            reservedAt: '2026-07-15T01:02:03.000Z',
            evidenceReferenceFile: '/secure/incident-reference.txt',
        });
    });

    it('rejects an incomplete or weakly confirmed mutation', () => {
        expect(() => parseAmbiguousStartOptions([])).toThrow(/choose exactly one/);
        expect(() => parseAmbiguousStartOptions([
            ...resolveArguments.slice(0, -1),
            '--confirm=yes',
        ])).toThrow(/--confirm must equal/);
        expect(() => parseAmbiguousStartOptions(
            resolveArguments.filter((argument) => !argument.startsWith('--input-hash='))
        )).toThrow(/--input-hash is required/);
    });

    it('rejects unbounded listing and identity drift', () => {
        expect(() => parseAmbiguousStartOptions(['--list', '--limit=101']))
            .toThrow(/1 through 100/);
        expect(() => parseAmbiguousStartOptions(resolveArguments.map((argument) =>
            argument === '--credential-slot=quinary'
                ? '--credential-slot=senary'
                : argument
        ))).toThrow(/unsupported --credential-slot/);
        expect(() => parseAmbiguousStartOptions(resolveArguments.map((argument) =>
            argument === '--max-charge-usd=0.002600000000'
                ? '--max-charge-usd=0'
                : argument
        ))).toThrow(/--max-charge-usd must be/);
    });
});
