import { describe, expect, it } from 'vitest';
import {
    EXPECTED_INPUT_COUNT,
    MAX_RUN_USD,
    MAX_TOTAL_USD,
    PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT,
    PROFILE_REPAIR_CANARY_MAX_RUN_USD,
    PROFILE_REPAIR_CANARY_MAX_TOTAL_USD,
    PROFILE_REPAIR_CANARY_REPEATS,
    parseProfileRepairCanaryArgs,
    sanitizeProfileRepairCanaryResult,
} from './canary-apify-profile-repair-options';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function requiredArgs(): string[] {
    return [
        '--source-request-id', SOURCE_REQUEST_ID,
        '--critical-job-key', 'track:profiles:batch:7',
        '--credential-slot', 'tertiary',
    ];
}

describe('profile repair canary arguments', () => {
    it('keeps replay mode incapable of starting or charging an Actor', () => {
        expect(parseProfileRepairCanaryArgs(requiredArgs())).toEqual({
            sourceRequestId: SOURCE_REQUEST_ID,
            criticalJobKey: 'track:profiles:batch:7',
            credentialSlot: 'tertiary',
            confirmPaidApiCall: false,
            repeats: 0,
            maximumRunChargeUsd: 0,
            maximumTotalChargeUsd: 0,
        });
    });

    it('uses fixed paid repetitions and immutable charge ceilings', () => {
        expect(parseProfileRepairCanaryArgs([
            ...requiredArgs(),
            '--confirm-paid-api-call',
        ])).toMatchObject({
            confirmPaidApiCall: true,
            repeats: 2,
            maximumRunChargeUsd: 0.05,
            maximumTotalChargeUsd: 0.10,
        });
        expect(PROFILE_REPAIR_CANARY_REPEATS).toBe(2);
        expect(PROFILE_REPAIR_CANARY_MAX_RUN_USD).toBe(0.05);
        expect(PROFILE_REPAIR_CANARY_MAX_TOTAL_USD).toBe(0.10);
        expect(PROFILE_REPAIR_CANARY_EXPECTED_INPUT_COUNT).toBe(15);
        expect(MAX_RUN_USD).toBe(0.05);
        expect(MAX_TOTAL_USD).toBe(0.10);
        expect(EXPECTED_INPUT_COUNT).toBe(15);
    });

    it.each([
        ['--source-request-id', 'not-a-uuid'],
        ['--critical-job-key', 'track:profiles:batch:07'],
        ['--critical-job-key', 'track:profiles:batch:0:extra'],
        ['--credential-slot', 'rotating-pool'],
    ])('rejects an invalid %s value', (flag, value) => {
        const args = requiredArgs();
        const index = args.indexOf(flag);
        args[index + 1] = value;
        expect(() => parseProfileRepairCanaryArgs(args)).toThrow('invalid arguments');
    });

    it.each([
        { args: [] },
        { args: ['--source-request-id', SOURCE_REQUEST_ID] },
        { args: [
            '--source-request-id', SOURCE_REQUEST_ID,
            '--critical-job-key', 'track:profiles:batch:7',
        ] },
    ])('requires one source, critical job, and credential slot', ({ args }) => {
        expect(() => parseProfileRepairCanaryArgs(args)).toThrow('required');
    });

    it.each([
        '--repeats',
        '--repeat-count',
        '--max-run-usd',
        '--max-total-usd',
        '--maximum-total-charge-usd',
    ])('rejects caller-controlled paid override %s', (override) => {
        expect(() => parseProfileRepairCanaryArgs([
            ...requiredArgs(),
            override, '999',
        ])).toThrow('fixed paid limits');
    });

    it('requires the exact valueless confirmation flag once', () => {
        expect(() => parseProfileRepairCanaryArgs([
            ...requiredArgs(),
            '--confirm-paid-api-call=true',
        ])).toThrow('confirmation flag');
        expect(() => parseProfileRepairCanaryArgs([
            ...requiredArgs(),
            '--confirm-paid-api-call',
            '--confirm-paid-api-call',
        ])).toThrow('confirmation flag');
    });

    it('rejects duplicate identities and unknown arguments', () => {
        expect(() => parseProfileRepairCanaryArgs([
            ...requiredArgs(),
            '--source-request-id', SOURCE_REQUEST_ID,
        ])).toThrow('exactly once');
        expect(() => parseProfileRepairCanaryArgs([
            ...requiredArgs(),
            '--username', 'sensitive.user',
        ])).toThrow('unknown argument');
    });
});

describe('profile repair canary report sanitization', () => {
    it('projects only the requested safe count from a sensitive object', () => {
        expect(sanitizeProfileRepairCanaryResult({
            requestedUsernames: ['sensitive.user'],
            token: 'secret',
            requestedCount: 15,
            runId: 'SensitiveRun1234',
            datasetId: 'SensitiveDataset1234',
            url: 'https://example.test/private',
            inputHash: 'a'.repeat(64),
            rawProviderMessage: 'private provider detail',
        })).toEqual({ requested_count: 15 });
    });

    it('emits only the bounded snake_case report contract', () => {
        const report = sanitizeProfileRepairCanaryResult({
            mode: 'paid_canary',
            sourceRunCount: 8,
            requestedCount: 15,
            criticalIncompleteCount: 3,
            runs: [{
                repetition: 1,
                lifecycleStatus: 'succeeded',
                terminalCount: 15,
                successCount: 14,
                unavailableCount: 1,
                incompleteCount: 0,
                otherFailureCount: 0,
                latencyMs: 12_345,
                actualCostUsd: 0.04,
                costStatus: 'actual',
                gatePassed: true,
                username: 'sensitive.user',
                providerMessage: 'private provider detail',
            }],
            totalActualCostUsd: 0.04,
            sessionMaximumExposureUsd: 0.10,
            costStatus: 'actual',
            gatePassed: true,
            ownerEmail: 'private@example.test',
        });

        expect(report).toEqual({
            mode: 'paid_canary',
            source_run_count: 8,
            requested_count: 15,
            critical_incomplete_count: 3,
            runs: [{
                repetition: 1,
                lifecycle_status: 'succeeded',
                terminal_count: 15,
                success_count: 14,
                unavailable_count: 1,
                incomplete_count: 0,
                other_failure_count: 0,
                latency_ms: 12_345,
                actual_cost_usd: 0.04,
                cost_status: 'actual',
                gate_passed: true,
            }],
            total_actual_cost_usd: 0.04,
            session_maximum_exposure_usd: 0.10,
            cost_status: 'actual',
            gate_passed: true,
        });
        const serialized = JSON.stringify(report);
        expect(serialized).not.toMatch(
            /sensitive|username|run_?id|dataset|token|hash|fingerprint|url|provider.*message|email/i
        );
    });

    it.each([
        { requestedCount: 16 },
        { sourceRunCount: 9 },
        { runs: [{ repetition: 3 }] },
        { runs: [{ repetition: 1, actualCostUsd: 0.051 }] },
        { sessionMaximumExposureUsd: 0.11 },
        { runs: [{ repetition: 1 }, { repetition: 2 }, { repetition: 2 }] },
    ])('rejects an out-of-bounds safe field', (value) => {
        expect(() => sanitizeProfileRepairCanaryResult(value)).toThrow('invalid report');
    });
});
