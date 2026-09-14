/**
 * Owner-only preparation entry point for the initial identity epoch.
 *
 * This module deliberately has no dotenv or process-environment discovery
 * path. The default executable constructs its exact provider readers from an
 * already-authenticated owner session and fails closed when that boundary is
 * unavailable or live evidence is ambiguous.
 */
import { EpochError, epochFail, type EpochErrorCode } from './capacity-identity-epoch/contracts';
import { pathToFileURL } from 'node:url';
import type { OwnerAuthBoundary } from './capacity-identity-epoch/owner-auth';
import { parsePreparationCommand, type OwnerPreparationOperator } from './capacity-identity-epoch/owner-preparation-operator';
import {
    buildTwoPassDescriptorProposal,
    type OwnerDescriptorAssemblyInput,
} from './capacity-identity-epoch/owner-descriptors';
import {
    runOwnerEpochThroughVerified,
    type OwnerFdBridgeOptions,
} from './capacity-identity-epoch/owner-fd-bridge';
import { createOwnerProductionCliDependencies } from './capacity-identity-epoch/owner-production';

function fail(code: EpochErrorCode): never {
    epochFail(code);
}

export type PreparationCliDependencies = Readonly<{
    /** Validated owner session; credential bytes never leave its closures. */
    ownerAuth: OwnerAuthBoundary;
    /** Preparation discovery/mutation adapters are supplied by the owner session. */
    preparation: Pick<OwnerPreparationOperator, 'inspect' | 'apply'>;
    /** A fresh descriptor read pass for each call. */
    readDescriptorPass: () => Promise<OwnerDescriptorAssemblyInput>;
    /** Only the fixed child bridge options are configurable for tests. */
    bridgeOptions?: OwnerFdBridgeOptions;
    /** Safe output seam for provider-free tests. */
    write?: (line: string) => void;
}>;

type SafeWriter = (line: string) => void;

function assertOwnerBoundary(value: OwnerAuthBoundary | undefined): asserts value is OwnerAuthBoundary {
    if (!value || typeof value !== 'object'
        || typeof value.vercelProjectId !== 'string'
        || typeof value.vercelTeamId !== 'string'
        || typeof value.vercelTokenProvider !== 'function'
        || typeof value.googleTokenProvider !== 'function') fail('OWNER_AUTH_UNAVAILABLE');
}

function requireDependencies(value: PreparationCliDependencies | undefined): PreparationCliDependencies {
    if (!value || !value.preparation
        || typeof value.preparation.inspect !== 'function'
        || typeof value.preparation.apply !== 'function'
        || typeof value.readDescriptorPass !== 'function') fail('OWNER_AUTH_UNAVAILABLE');
    assertOwnerBoundary(value.ownerAuth);
    return value;
}

function defaultWriter(line: string): void {
    process.stdout.write(`${line}\n`);
}

function prepareInspectOutput(summary: Readonly<{
    proposalDigest: string;
    discoveryDigest: string;
    reusedCount: number;
    missingCount: number;
    actionKinds: Readonly<Record<string, number>>;
}>): string {
    const pauseCount = summary.actionKinds['scheduler.pause'] ?? 0;
    return `PREPARE_INSPECT_OK proposalDigest=${summary.proposalDigest} discoveryDigest=${summary.discoveryDigest} reused=${summary.reusedCount} missing=${summary.missingCount} schedulerPause=${pauseCount}`;
}

function prepareApplyOutput(result: Readonly<{
    proposalDigest: string;
    createdAccounts: number;
    pausedSchedulers: number;
}>): string {
    return `PREPARE_APPLY_OK proposalDigest=${result.proposalDigest} createdAccounts=${result.createdAccounts} pausedSchedulers=${result.pausedSchedulers}`;
}

function epochInspectOutput(value: Readonly<{
    proposalDigest: string;
    first: Readonly<{
        packetDigest: string;
        bootstrapDigest: string;
        scopeDigest: string;
        identityGraphDigest: string;
    }>;
}>): string {
    return `EPOCH_INSPECT_OK proposalDigest=${value.proposalDigest} packetDigest=${value.first.packetDigest} bootstrapDigest=${value.first.bootstrapDigest} scopeDigest=${value.first.scopeDigest} identityGraphDigest=${value.first.identityGraphDigest}`;
}

/** Execute one of the four strict owner-only commands. */
export async function runPreparationCli(
    argv: readonly string[],
    dependencies?: PreparationCliDependencies,
): Promise<void> {
    const command = parsePreparationCommand(argv);
    const deps = requireDependencies(dependencies ?? await createOwnerProductionCliDependencies());
    const write: SafeWriter = deps.write ?? defaultWriter;
    if (command.command === 'prepare.inspect') {
        const proposal = await deps.preparation.inspect();
        write(prepareInspectOutput(proposal.summary));
        return;
    }
    if (command.command === 'prepare.apply') {
        const result = await deps.preparation.apply(command.approvedDigest!);
        write(prepareApplyOutput(result));
        return;
    }

    const proposal = await buildTwoPassDescriptorProposal({ readPass: deps.readDescriptorPass });
    if (command.command === 'epoch.inspect') {
        write(epochInspectOutput(proposal));
        return;
    }
    if (proposal.proposalDigest !== command.approvedDigest || command.through !== 'VERIFIED') fail('PROPOSAL_STALE');
    const result = await runOwnerEpochThroughVerified({
        packet: proposal.second.packet,
        bootstrap: proposal.second.bootstrap,
        options: deps.bridgeOptions,
    });
    if (result.status !== 'VERIFIED_OK') fail('PROTECTED_PIPE_FAILED');
    write('VERIFIED_OK');
}

export const runOwnerPreparationCli = runPreparationCli;

const invokedScript = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedScript) {
    void runPreparationCli(process.argv.slice(2)).catch((error: unknown) => {
        if (error instanceof EpochError) {
            process.stderr.write(`${error.code}\n`);
            process.exitCode = 2;
        } else {
            process.stderr.write('OWNER_AUTH_UNAVAILABLE\n');
            process.exitCode = 2;
        }
    });
}
