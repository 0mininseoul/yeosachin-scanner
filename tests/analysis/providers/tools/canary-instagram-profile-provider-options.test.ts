import { describe, expect, it } from 'vitest';
import {
    PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT,
    PROFILE_PROVIDER_CANARY_MAX_LATENCY_MS,
    PROFILE_PROVIDER_CANARY_MAX_RUN_USD,
    PROFILE_PROVIDER_CANARY_MAX_TOTAL_USD,
    PROFILE_PROVIDER_CANARY_REPEATS,
    parseInstagramProfileProviderCanaryArgs,
    sanitizeInstagramProfileProviderCanaryResult,
} from '../../../../scripts/canary-instagram-profile-provider-options';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function validInternalReport(): Record<string, unknown> {
    return {
        mode: 'paid_canary',
        sourceRunCount: 8,
        requestedCount: 15,
        criticalIncompleteCount: 3,
        runs: [{
            repetition: 1,
            lifecycleStatus: 'succeeded',
            terminalCount: 15,
            successCount: 15,
            unavailableCount: 0,
            incompleteCount: 0,
            otherFailureCount: 0,
            latencyMs: 60_000,
            buildMatched: true,
            restrictedAccess: true,
            actualCostUsd: 0.04,
            costStatus: 'actual',
            cleanup: {
                keyValueStore: true,
                dataset: true,
                requestQueue: true,
            },
            gatePassed: false,
        }],
        totalActualCostUsd: 0.04,
        sessionMaximumExposureUsd: 0.10,
        costStatus: 'actual',
        sourceCleanupComplete: false,
        experimentTerminal: false,
        gatePassed: false,
    };
}

function requiredArgs(): string[] {
    return ['--source-request-id', SOURCE_REQUEST_ID];
}

describe('Instagram profile provider canary arguments', () => {
    it('keeps default replay incapable of paid starts', () => {
        expect(parseInstagramProfileProviderCanaryArgs(requiredArgs())).toEqual({
            sourceRequestId: SOURCE_REQUEST_ID,
            confirmPaidApiCall: false,
            repetitions: 0,
            maximumRunChargeUsd: 0,
            maximumTotalChargeUsd: 0,
        });
    });

    it('accepts one exact valueless paid confirmation with immutable limits', () => {
        expect(parseInstagramProfileProviderCanaryArgs([
            ...requiredArgs(),
            '--confirm-paid-api-call',
        ])).toEqual({
            sourceRequestId: SOURCE_REQUEST_ID,
            confirmPaidApiCall: true,
            repetitions: 2,
            maximumRunChargeUsd: 0.05,
            maximumTotalChargeUsd: 0.10,
        });
        expect(PROFILE_PROVIDER_CANARY_REPEATS).toBe(2);
        expect(PROFILE_PROVIDER_CANARY_MAX_RUN_USD).toBe(0.05);
        expect(PROFILE_PROVIDER_CANARY_MAX_TOTAL_USD).toBe(0.10);
        expect(PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT).toBe(15);
        expect(PROFILE_PROVIDER_CANARY_MAX_LATENCY_MS).toBe(60_000);
    });

    it('rejects valued, duplicate, and caller-controlled paid options', () => {
        expect(() => parseInstagramProfileProviderCanaryArgs([
            ...requiredArgs(),
            '--confirm-paid-api-call=true',
        ])).toThrow('exact and valueless');
        expect(() => parseInstagramProfileProviderCanaryArgs([
            ...requiredArgs(),
            '--confirm-paid-api-call',
            '--confirm-paid-api-call',
        ])).toThrow('exactly once');

        for (const override of [
            '--repeats',
            '--max-run-usd',
            '--max-total-usd',
            '--actor-id',
            '--actor-build',
            '--credential-slot',
        ]) {
            expect(() => parseInstagramProfileProviderCanaryArgs([
                ...requiredArgs(),
                override,
                'unsafe',
            ])).toThrow('fixed paid identity');
        }
    });

    it('requires one canonical source identity and rejects unknown arguments', () => {
        expect(() => parseInstagramProfileProviderCanaryArgs([])).toThrow('required');
        expect(() => parseInstagramProfileProviderCanaryArgs([
            '--source-request-id',
            'not-a-uuid',
        ])).toThrow('invalid arguments');
        expect(() => parseInstagramProfileProviderCanaryArgs([
            ...requiredArgs(),
            '--source-request-id',
            SOURCE_REQUEST_ID,
        ])).toThrow('exactly once');
        expect(() => parseInstagramProfileProviderCanaryArgs([
            ...requiredArgs(),
            '--username',
            'sensitive.user',
        ])).toThrow('unknown argument');
    });
});

describe('Instagram profile provider canary report sanitization', () => {
    it('projects only the bounded aggregate contract', () => {
        const report = sanitizeInstagramProfileProviderCanaryResult({
            mode: 'paid_canary',
            sourceRunCount: 8,
            requestedCount: 15,
            criticalIncompleteCount: 3,
            runs: [{
                repetition: 1,
                lifecycleStatus: 'succeeded',
                terminalCount: 15,
                successCount: 15,
                unavailableCount: 0,
                incompleteCount: 0,
                otherFailureCount: 0,
                latencyMs: 60_000,
                buildMatched: true,
                restrictedAccess: true,
                actualCostUsd: 0.04,
                costStatus: 'actual',
                cleanup: {
                    keyValueStore: true,
                    dataset: true,
                    requestQueue: true,
                },
                gatePassed: true,
                username: 'sensitive.user',
                runId: 'SensitiveRun1234',
                datasetId: 'SensitiveDataset1234',
                inputHash: 'a'.repeat(64),
                providerMessage: 'private detail',
            }],
            totalActualCostUsd: 0.04,
            sessionMaximumExposureUsd: 0.10,
            costStatus: 'actual',
            sourceCleanupComplete: true,
            experimentTerminal: true,
            gatePassed: false,
            sourceRequestId: SOURCE_REQUEST_ID,
            token: 'secret',
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
                success_count: 15,
                unavailable_count: 0,
                incomplete_count: 0,
                other_failure_count: 0,
                latency_ms: 60_000,
                build_matched: true,
                restricted_access: true,
                actual_cost_usd: 0.04,
                cost_status: 'actual',
                cleanup: {
                    key_value_store: true,
                    dataset: true,
                    request_queue: true,
                },
                gate_passed: true,
            }],
            total_actual_cost_usd: 0.04,
            session_maximum_exposure_usd: 0.10,
            cost_status: 'actual',
            source_cleanup_complete: true,
            experiment_terminal: true,
            gate_passed: false,
        });
        expect(JSON.stringify(report)).not.toMatch(
            /sensitive|username|run_?id|dataset_?id|token|hash|url|provider.*message|email/i
        );
    });

    it.each([
        { requestedCount: 16 },
        { sourceRunCount: 9 },
        { runs: [{ repetition: 3 }] },
        { runs: [{ repetition: 1, actualCostUsd: 0.051 }] },
        { runs: [{
            repetition: 1,
            terminalCount: 15,
            successCount: 14,
            unavailableCount: 0,
            incompleteCount: 0,
            otherFailureCount: 0,
        }] },
        { runs: [{ repetition: 1 }, { repetition: 1 }] },
        { sessionMaximumExposureUsd: 0.11 },
    ])('rejects an inconsistent or out-of-bounds report field', value => {
        expect(() => sanitizeInstagramProfileProviderCanaryResult(value))
            .toThrow('invalid report');
    });

    it('uses strict output enums and a bounded diagnostic latency', () => {
        const base = validInternalReport();
        for (const mutation of [
            { mode: 'provider private text' },
            { costStatus: 'provider private text' },
            { runs: [{ ...(base.runs as Record<string, unknown>[])[0], lifecycleStatus: 'private text' }] },
            { runs: [{ ...(base.runs as Record<string, unknown>[])[0], costStatus: 'private text' }] },
            { runs: [{ ...(base.runs as Record<string, unknown>[])[0], latencyMs: 300_001 }] },
        ]) {
            expect(() => sanitizeInstagramProfileProviderCanaryResult({ ...base, ...mutation }))
                .toThrow('invalid report');
        }
    });

    it('represents unsettled cost as null and rejects contradictory gate, cost, and cleanup claims', () => {
        const base = validInternalReport();
        const run = (base.runs as Record<string, unknown>[])[0];
        const unsettled = {
            ...base,
            runs: [{
                ...run,
                lifecycleStatus: 'ambiguous',
                terminalCount: 0,
                successCount: 0,
                latencyMs: 0,
                buildMatched: false,
                restrictedAccess: false,
                actualCostUsd: null,
                costStatus: 'unknown',
                cleanup: { keyValueStore: false, dataset: false, requestQueue: false },
                gatePassed: false,
            }],
            totalActualCostUsd: null,
            costStatus: 'unknown',
        };
        expect(sanitizeInstagramProfileProviderCanaryResult(unsettled)).toMatchObject({
            total_actual_cost_usd: null,
            cost_status: 'unknown',
        });

        for (const invalid of [
            { ...base, totalActualCostUsd: null, costStatus: 'actual' },
            { ...base, runs: [{ ...run, actualCostUsd: null, costStatus: 'actual' }] },
            { ...base, runs: [{ ...run, actualCostUsd: null, costStatus: 'conservative' }] },
            { ...base, runs: [{ ...run, successCount: 14, incompleteCount: 1, gatePassed: true }] },
            { ...base, sourceCleanupComplete: true, experimentTerminal: false },
            { ...base, gatePassed: true },
        ]) {
            expect(() => sanitizeInstagramProfileProviderCanaryResult(invalid))
                .toThrow('invalid report');
        }
    });
});
