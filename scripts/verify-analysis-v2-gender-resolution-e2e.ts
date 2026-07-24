import { pathToFileURL } from 'node:url';
import {
    analysisV2GenderResolutionQualityStore,
    type AnalysisV2GenderResolutionQuality,
} from '../lib/services/analysis/v2-gender-resolution-quality';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GenderResolutionE2ECliDependencies {
    loadQuality(requestId: string): Promise<AnalysisV2GenderResolutionQuality>;
    writeStdout(value: string): void;
}

export function parseGenderResolutionE2ECliArgs(args: readonly string[]): string {
    if (args.length !== 1 || !args[0]?.startsWith('--request-id=')) {
        throw new Error('exactly one --request-id=<uuid> argument is required');
    }
    const requestId = args[0].slice('--request-id='.length);
    if (!UUID_PATTERN.test(requestId)) {
        throw new Error('--request-id must be a UUID');
    }
    return requestId;
}

function defaultDependencies(): GenderResolutionE2ECliDependencies {
    return {
        loadQuality: requestId =>
            analysisV2GenderResolutionQualityStore.load(requestId),
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runGenderResolutionE2EQualityCli(
    args: readonly string[],
    dependencies: GenderResolutionE2ECliDependencies = defaultDependencies()
): Promise<{ exitCode: 0 | 1 }> {
    const requestId = parseGenderResolutionE2ECliArgs(args);
    const quality = await dependencies.loadQuality(requestId);
    const report = Object.freeze({
        screenedCount: quality.screenedCount,
        baselineUnknownCount: quality.baselineUnknownCount,
        finalUnknownCount: quality.finalUnknownCount,
        finalUnknownRatio: quality.finalUnknownRatio,
        appliedCount: quality.appliedCount,
        appliedWithFencedResultCount: quality.appliedWithFencedResultCount,
        verifiedBaselineMutationCount: quality.verifiedBaselineMutationCount,
        resolverUsageCompleteCount: quality.resolverUsageCompleteCount,
        resolverUsageMissingCount: quality.resolverUsageMissingCount,
        resolverEstimatedCostUsd: quality.resolverEstimatedCostUsd,
        resolverCostKnownCount: quality.resolverCostKnownCount,
        resolverCostUnknownCount:
            quality.resolverAttemptCount - quality.resolverCostKnownCount,
        resolverConcurrencyLimit: quality.resolverConcurrencyLimit,
        sharedConcurrencyLimit: quality.sharedConcurrencyLimit,
        unknownGateEvaluable: quality.unknownGateEvaluable,
        unknownGatePassed: quality.unknownGatePassed,
        provenanceGatePassed: quality.provenanceGatePassed,
        immutabilityGatePassed: quality.immutabilityGatePassed,
        qualityGatePassed: quality.qualityGatePassed,
    });
    dependencies.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
    return { exitCode: quality.qualityGatePassed ? 0 : 1 };
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runGenderResolutionE2EQualityCli(process.argv.slice(2))
        .then(result => {
            process.exitCode = result.exitCode;
        })
        .catch(() => {
            process.stderr.write(`${JSON.stringify({
                status: 'failed',
                errorCode: 'ANALYSIS_V2_GENDER_RESOLUTION_E2E_FAILED',
            })}\n`);
            process.exitCode = 1;
        });
}
