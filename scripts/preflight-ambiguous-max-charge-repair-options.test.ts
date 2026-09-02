import { describe, expect, it } from 'vitest';
import {
    IDENTITY_DRIFT_REPAIR_CONFIRMATION,
    parseIdentityDriftRepairOptions,
} from './preflight-ambiguous-max-charge-repair-options';

const resolveArguments = [
    '--resolve',
    '--preflight-id=00000000-0000-4000-8000-000000000001',
    '--operation-key=target-profile-fallback',
    `--input-hash=${'a'.repeat(64)}`,
    '--logical-provider=apify',
    '--actor-id=apify/instagram-profile-scraper',
    '--credential-slot=primary',
    '--max-charge-usd=0.002600000000',
    '--reserved-at=2026-08-12T13:54:00.000Z',
    '--evidence-reference-file=/secure/incident-reference.txt',
    '--output-file=/tmp/repair.sql',
    `--confirm=${IDENTITY_DRIFT_REPAIR_CONFIRMATION}`,
];

describe('identity-drift max-charge repair CLI options', () => {
    it('bounds listing and accepts only the exact fallback identity', () => {
        expect(parseIdentityDriftRepairOptions(['--list', '--output-file=/tmp/candidates.json'])).toEqual({
            mode: 'list',
            limit: 20,
            outputFile: '/tmp/candidates.json',
        });
        expect(parseIdentityDriftRepairOptions([
            '--list', '--limit=100', '--output-file=/tmp/candidates.json'
        ])).toEqual({
            mode: 'list',
            limit: 100,
            outputFile: '/tmp/candidates.json',
        });
        expect(parseIdentityDriftRepairOptions(resolveArguments)).toMatchObject({
            mode: 'resolve',
            preflightId: '00000000-0000-4000-8000-000000000001',
            operationKey: 'target-profile-fallback',
            inputHash: 'a'.repeat(64),
            credentialSlot: 'primary',
            maxChargeUsd: '0.002600000000',
        });
    });

    it('rejects broad, weakly confirmed, or drifted requests', () => {
        expect(() => parseIdentityDriftRepairOptions(['--list']))
            .toThrow(/--output-file is required/);
        expect(() => parseIdentityDriftRepairOptions(['--list', '--limit=101']))
            .toThrow(/1 through 100/);
        expect(() => parseIdentityDriftRepairOptions(resolveArguments.map((argument) =>
            argument === '--operation-key=target-profile-fallback'
                ? '--operation-key=target-profile-fresh-admission:g4'
                : argument
        ))).toThrow(/unsupported --operation-key/);
        expect(() => parseIdentityDriftRepairOptions(resolveArguments.map((argument) =>
            argument.startsWith('--confirm=') ? '--confirm=unknown' : argument
        ))).toThrow(/--confirm must equal/);
        expect(() => parseIdentityDriftRepairOptions(resolveArguments.map((argument) =>
            argument === '--max-charge-usd=0.002600000000'
                ? '--max-charge-usd=0.0026'
                : argument
        ))).toThrow(/--max-charge-usd must be/);
    });
});
