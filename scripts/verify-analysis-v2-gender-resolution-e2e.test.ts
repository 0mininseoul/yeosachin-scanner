import { describe, expect, it, vi } from 'vitest';
import type {
    AnalysisV2GenderResolutionQuality,
} from '../lib/services/analysis/v2-gender-resolution-quality';
import {
    parseGenderResolutionE2ECliArgs,
    runGenderResolutionE2EQualityCli,
} from './verify-analysis-v2-gender-resolution-e2e';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

function quality(
    overrides: Partial<AnalysisV2GenderResolutionQuality> = {}
): AnalysisV2GenderResolutionQuality {
    return {
        screenedCount: 10,
        resolverEligibleCount: 5,
        baselineUnknownCount: 5,
        finalUnknownCount: 3,
        finalUnknownRatio: 0.3,
        readyCount: 3,
        appliedCount: 2,
        appliedWithFencedResultCount: 2,
        verifiedBaselineMutationCount: 0,
        inconclusiveCount: 1,
        cutoffCount: 1,
        capacitySkippedCount: 0,
        terminalUnavailableCount: 0,
        partialMediaAcceptedCandidateCount: 1,
        selectedMediaTotal: 25,
        normalizedMediaTotal: 24,
        failedMediaTotal: 1,
        resolverAttemptCount: 3,
        resolverUsageCompleteCount: 2,
        resolverUsageMissingCount: 1,
        resolverEstimatedCostUsd: 0.0001,
        resolverCostKnownCount: 2,
        resolverNonterminalAttemptCount: 0,
        resolverConcurrencyLimit: 2,
        sharedConcurrencyLimit: 8,
        allResolverAttemptsTerminal: true,
        metricsFinalized: true,
        metricsFresh: true,
        requestCompleted: true,
        standardPlan: true,
        resultArchivePresent: true,
        requestGatePassed: true,
        unknownGateEvaluable: true,
        unknownGatePassed: true,
        provenanceGatePassed: true,
        immutabilityGatePassed: true,
        qualityGatePassed: true,
        ...overrides,
    };
}

describe('gender resolution E2E quality CLI', () => {
    it('accepts only one exact request UUID input', () => {
        expect(parseGenderResolutionE2ECliArgs([
            `--request-id=${requestId}`,
        ])).toBe(requestId);
        expect(() => parseGenderResolutionE2ECliArgs([
            '--request-id', requestId,
        ])).toThrow();
        expect(() => parseGenderResolutionE2ECliArgs([
            `--request-id=${requestId}`,
            '--username=sensitive',
        ])).toThrow();
    });

    it('prints only bounded aggregate gates and passes exactly 30 percent', async () => {
        const writeStdout = vi.fn();
        const result = await runGenderResolutionE2EQualityCli([
            `--request-id=${requestId}`,
        ], {
            loadQuality: vi.fn(async () => quality()),
            writeStdout,
        });
        expect(result.exitCode).toBe(0);
        const output = JSON.parse(writeStdout.mock.calls[0]![0]);
        expect(output).toMatchObject({
            screenedCount: 10,
            finalUnknownCount: 3,
            finalUnknownRatio: 0.3,
            resolverUsageCompleteCount: 2,
            resolverUsageMissingCount: 1,
            resolverCostKnownCount: 2,
            resolverCostUnknownCount: 1,
            resolverConcurrencyLimit: 2,
            sharedConcurrencyLimit: 8,
            requestCompleted: true,
            standardPlan: true,
            resultArchivePresent: true,
            requestGatePassed: true,
            allResolverAttemptsTerminal: true,
            metricsFinalized: true,
            metricsFresh: true,
            qualityGatePassed: true,
        });
        for (const forbidden of [
            'requestId', 'ownerId', 'username', 'selectionIds', 'resultHash',
            'operationKey', 'resolverTokenUsage', 'providerMessage',
            'policyVersion',
        ]) {
            expect(output).not.toHaveProperty(forbidden);
        }
    });

    it('returns nonzero above 30 percent without mutating classifications', async () => {
        const writeStdout = vi.fn();
        const loadQuality = vi.fn(async () => quality({
            finalUnknownCount: 4,
            finalUnknownRatio: 0.4,
            unknownGatePassed: false,
            qualityGatePassed: false,
        }));
        const result = await runGenderResolutionE2EQualityCli([
            `--request-id=${requestId}`,
        ], { loadQuality, writeStdout });
        expect(result.exitCode).toBe(1);
        expect(loadQuality).toHaveBeenCalledOnce();
        expect(JSON.parse(writeStdout.mock.calls[0]![0])).toMatchObject({
            finalUnknownRatio: 0.4,
            unknownGatePassed: false,
            qualityGatePassed: false,
        });
    });

    it('returns nonzero for a staging row even when unknown quality passes', async () => {
        const writeStdout = vi.fn();
        const result = await runGenderResolutionE2EQualityCli([
            `--request-id=${requestId}`,
        ], {
            loadQuality: async () => quality({
                requestCompleted: false,
                resultArchivePresent: false,
                requestGatePassed: false,
                qualityGatePassed: false,
            }),
            writeStdout,
        });
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(writeStdout.mock.calls[0]![0])).toMatchObject({
            requestCompleted: false,
            standardPlan: true,
            resultArchivePresent: false,
            requestGatePassed: false,
            unknownGatePassed: true,
            qualityGatePassed: false,
        });
    });

    it('returns nonzero while resolver recovery or metrics sealing remains pending', async () => {
        const writeStdout = vi.fn();
        const result = await runGenderResolutionE2EQualityCli([
            `--request-id=${requestId}`,
        ], {
            loadQuality: async () => quality({
                resolverNonterminalAttemptCount: 1,
                allResolverAttemptsTerminal: false,
                metricsFinalized: false,
                metricsFresh: false,
                qualityGatePassed: false,
            }),
            writeStdout,
        });
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(writeStdout.mock.calls[0]![0])).toMatchObject({
            resolverNonterminalAttemptCount: 1,
            allResolverAttemptsTerminal: false,
            metricsFinalized: false,
            metricsFresh: false,
            qualityGatePassed: false,
        });
    });
});
