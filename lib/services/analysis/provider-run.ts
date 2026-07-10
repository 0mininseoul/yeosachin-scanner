import type { SupabaseClient } from '@supabase/supabase-js';
import {
    getApifyClient,
} from '@/lib/services/instagram/providers/apify-relationship';
import type {
    ApifyCredentialSlot,
    ProviderCostRunStarted,
    ProviderCostTerminalStatus,
    ProviderRunCheckpoint,
} from '@/lib/services/instagram/providers/types';
import {
    recordAnalysisProviderRunFinished,
    recordAnalysisProviderRunStarted,
    type ProviderCostAnalysisStep,
} from './provider-cost-ledger';

const OPERATION_KEY_PATTERN = /^(?:profile:target|profiles:(?:0|[1-9][0-9]{0,6})|relationship:(?:followers|following)|interaction:(?:target_likers|target_comments|candidate_likers):(?:0|[1-9][0-9]{0,6}))$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$/;
const MAX_PROVIDER_CHARGE_USD = 100_000;
const MAX_ABORT_RUNS = 64;
const ABORT_WAIT_SECS = 30;

type LogicalApifyProvider = 'apify' | 'coderx';

type ProviderRunClient = Pick<SupabaseClient, 'from' | 'rpc'>;

interface ProviderRunInput {
    requestId: string;
    userId: string;
    expectedStep: ProviderCostAnalysisStep;
    operationKey: string;
}

interface ProviderRunIdentity {
    logicalProvider: LogicalApifyProvider;
    actorId: string;
    credentialSlot: ApifyCredentialSlot;
    maxChargeUsd: number;
}

export interface StoredAnalysisProviderRun extends ProviderRunIdentity {
    status: 'starting' | 'running';
    runId?: string;
}

function assertOperationKey(operationKey: string): void {
    if (!OPERATION_KEY_PATTERN.test(operationKey)) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: invalid operation key.');
    }
}

function assertProviderRunIdentity(identity: ProviderRunIdentity): void {
    if (!['apify', 'coderx'].includes(identity.logicalProvider)) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: invalid logical provider.');
    }
    if (!ACTOR_ID_PATTERN.test(identity.actorId)) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: invalid actor id.');
    }
    if (identity.credentialSlot !== 'primary' && identity.credentialSlot !== 'secondary') {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: invalid credential slot.');
    }
    if (
        !Number.isFinite(identity.maxChargeUsd)
        || identity.maxChargeUsd < 0
        || identity.maxChargeUsd > MAX_PROVIDER_CHARGE_USD
    ) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: invalid maximum charge.');
    }
}

function operationMatchesStep(
    operationKey: string,
    expectedStep: ProviderCostAnalysisStep
): boolean {
    if (expectedStep === 'collect') {
        return operationKey === 'profile:target' || operationKey.startsWith('relationship:');
    }
    if (expectedStep === 'profiles') return operationKey.startsWith('profiles:');
    return operationKey.startsWith('interaction:');
}

function parseStoredCharge(value: unknown): number {
    if (
        typeof value !== 'number'
        && !(typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))
    ) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: stored maximum charge is invalid.');
    }
    const charge = Number(value);
    if (!Number.isFinite(charge) || charge < 0 || charge > MAX_PROVIDER_CHARGE_USD) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: stored maximum charge is invalid.');
    }
    return charge;
}

function safeErrorCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

export async function getAnalysisProviderRun(
    client: ProviderRunClient,
    input: Pick<ProviderRunInput, 'requestId' | 'operationKey'>
): Promise<StoredAnalysisProviderRun | undefined> {
    assertOperationKey(input.operationKey);
    const { data, error } = await client
        .from('analysis_provider_runs')
        .select('logical_provider, actor_id, credential_slot, max_charge_usd, status, run_id')
        .eq('request_id', input.requestId)
        .eq('operation_key', input.operationKey)
        .maybeSingle();
    if (error) {
        throw new Error(
            `ANALYSIS_PERSISTENCE_ERROR: provider run checkpoint read failed (${safeErrorCode(error)}).`
        );
    }
    if (!data) return undefined;
    const stored = data as Record<string, unknown>;
    const logicalProvider = stored.logical_provider;
    const actorId = stored.actor_id;
    const credentialSlot = stored.credential_slot;
    const status = stored.status;
    if (
        (logicalProvider !== 'apify' && logicalProvider !== 'coderx')
        || typeof actorId !== 'string'
        || !ACTOR_ID_PATTERN.test(actorId)
        || (credentialSlot !== 'primary' && credentialSlot !== 'secondary')
        || (status !== 'starting' && status !== 'running')
    ) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: stored run identity is invalid.');
    }
    const maxChargeUsd = parseStoredCharge(stored.max_charge_usd);
    if (status === 'starting') {
        if (stored.run_id !== null) {
            throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: starting run has an unexpected id.');
        }
        return { logicalProvider, actorId, credentialSlot, maxChargeUsd, status };
    }
    if (typeof stored.run_id !== 'string' || !RUN_ID_PATTERN.test(stored.run_id)) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: stored run id is invalid.');
    }
    return {
        logicalProvider,
        actorId,
        credentialSlot,
        maxChargeUsd,
        status,
        runId: stored.run_id,
    };
}

export async function reserveAnalysisProviderRun(
    client: ProviderRunClient,
    input: ProviderRunInput & ProviderRunIdentity
): Promise<void> {
    assertOperationKey(input.operationKey);
    assertProviderRunIdentity(input);
    if (!operationMatchesStep(input.operationKey, input.expectedStep)) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: operation does not match pipeline step.');
    }
    const { data, error } = await client.rpc('reserve_analysis_provider_run', {
        p_request_id: input.requestId,
        p_user_id: input.userId,
        p_expected_step: input.expectedStep,
        p_operation_key: input.operationKey,
        p_logical_provider: input.logicalProvider,
        p_actor_id: input.actorId,
        p_credential_slot: input.credentialSlot,
        p_max_charge_usd: input.maxChargeUsd,
    });
    if (error) {
        throw new Error(
            `ANALYSIS_PERSISTENCE_ERROR: provider run intent reservation failed (${safeErrorCode(error)}).`
        );
    }
    if (data !== true) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: provider run intent already exists.');
    }
}

export async function checkpointAnalysisProviderRun(
    client: ProviderRunClient,
    input: ProviderRunInput & ProviderRunIdentity & { runId: string }
): Promise<void> {
    assertOperationKey(input.operationKey);
    assertProviderRunIdentity(input);
    if (!operationMatchesStep(input.operationKey, input.expectedStep)) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: operation does not match pipeline step.');
    }
    if (!RUN_ID_PATTERN.test(input.runId)) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: invalid run id.');
    }
    const { data, error } = await client.rpc('checkpoint_analysis_provider_run', {
        p_request_id: input.requestId,
        p_user_id: input.userId,
        p_expected_step: input.expectedStep,
        p_operation_key: input.operationKey,
        p_logical_provider: input.logicalProvider,
        p_actor_id: input.actorId,
        p_credential_slot: input.credentialSlot,
        p_max_charge_usd: input.maxChargeUsd,
        p_run_id: input.runId,
    });
    if (error) {
        throw new Error(
            `ANALYSIS_PROVIDER_RUN_ERROR: checkpoint write failed (${safeErrorCode(error)}).`
        );
    }
    if (data !== true) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: request state did not match.');
    }
}

export async function clearAnalysisProviderRun(
    client: ProviderRunClient,
    input: Pick<ProviderRunInput, 'requestId' | 'operationKey'>
): Promise<void> {
    assertOperationKey(input.operationKey);
    const { error } = await client
        .from('analysis_provider_runs')
        .delete()
        .eq('request_id', input.requestId)
        .eq('operation_key', input.operationKey);
    if (error) {
        throw new Error(
            `ANALYSIS_PERSISTENCE_ERROR: provider run checkpoint cleanup failed (${safeErrorCode(error)}).`
        );
    }
}

export async function analysisProviderRunCheckpoint(
    client: ProviderRunClient,
    input: ProviderRunInput
): Promise<ProviderRunCheckpoint> {
    if (!operationMatchesStep(input.operationKey, input.expectedStep)) {
        throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: operation does not match pipeline step.');
    }
    const stored = await getAnalysisProviderRun(client, input);
    let boundIdentity: ProviderRunIdentity | undefined = stored;
    let confirmedRunId = stored?.runId;
    const assertCostIdentity = (run: ProviderCostRunStarted): {
        identity: ProviderRunIdentity;
        runId: string;
    } => {
        const identity = boundIdentity;
        if (!identity || !confirmedRunId) {
            throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: cost event has no confirmed run.');
        }
        assertProviderRunIdentity(run);
        if (
            run.logicalProvider !== identity.logicalProvider
            || run.actorId !== identity.actorId
            || run.credentialSlot !== identity.credentialSlot
            || run.maxChargeUsd !== identity.maxChargeUsd
            || run.runId !== confirmedRunId
        ) {
            throw new Error('ANALYSIS_PROVIDER_RUN_ERROR: cost event identity does not match.');
        }
        return { identity, runId: confirmedRunId };
    };
    const costCallbacks: Pick<
        ProviderRunCheckpoint,
        'onCostRunStarted' | 'onCostRunFinished'
    > = {
        onCostRunStarted: async (run) => {
            const { identity, runId } = assertCostIdentity(run);
            await recordAnalysisProviderRunStarted(client, { ...input, ...identity, runId });
        },
        onCostRunFinished: async (run) => {
            const { identity, runId } = assertCostIdentity(run);
            await recordAnalysisProviderRunFinished(client, {
                ...input,
                ...identity,
                runId,
                status: run.status,
                usageTotalUsd: run.usageTotalUsd,
            });
        },
    };
    if (stored) {
        return {
            ...costCallbacks,
            logicalProvider: stored.logicalProvider,
            actorId: stored.actorId,
            credentialSlot: stored.credentialSlot,
            maxChargeUsd: stored.maxChargeUsd,
            ...(stored.runId ? { resumeRunId: stored.runId } : {}),
            ...(stored.status === 'starting' ? { startReserved: true } : {}),
        };
    }

    return {
        ...costCallbacks,
        onBeforeRunStart: async (identity) => {
            assertProviderRunIdentity(identity);
            await reserveAnalysisProviderRun(client, { ...input, ...identity });
            boundIdentity = identity;
        },
        onRunStarted: async (runId) => {
            if (!boundIdentity) {
                throw new Error(
                    'ANALYSIS_PROVIDER_RUN_ERROR: run started without a reserved intent.'
                );
            }
            await checkpointAnalysisProviderRun(client, {
                ...input,
                ...boundIdentity,
                runId,
            });
            confirmedRunId = runId;
        },
    };
}

interface AbortProviderRunsInput {
    requestId: string;
    userId: string;
    /** Current route step, retained for call-site compatibility; each row is classified independently. */
    expectedStep?: ProviderCostAnalysisStep;
}

interface AbortProviderRunsDeps {
    env?: Record<string, string | undefined>;
    clientForSlot?(slot: ApifyCredentialSlot): AbortApifyClient;
}

interface StoredRunningProviderRun extends ProviderRunIdentity {
    operationKey: string;
    expectedStep: ProviderCostAnalysisStep;
    runId: string;
}

interface ApifyRunSnapshot {
    status?: unknown;
    usageTotalUsd?: unknown;
}

interface AbortApifyRunClient {
    get(): Promise<ApifyRunSnapshot | undefined>;
    abort(): Promise<ApifyRunSnapshot>;
    waitForFinish(options: { waitSecs: number }): Promise<ApifyRunSnapshot>;
}

interface AbortApifyClient {
    run(runId: string): AbortApifyRunClient;
}

function terminalProviderStatus(status: unknown): ProviderCostTerminalStatus | undefined {
    switch (status) {
        case 'SUCCEEDED':
            return 'succeeded';
        case 'FAILED':
            return 'failed';
        case 'ABORTED':
            return 'aborted';
        case 'TIMED-OUT':
            return 'timed_out';
        default:
            return undefined;
    }
}

function validateStoredRunningProviderRun(
    value: unknown
): StoredRunningProviderRun {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: stored provider run is invalid.');
    }
    const row = value as Record<string, unknown>;
    const operationKey = row.operation_key;
    const logicalProvider = row.logical_provider;
    const actorId = row.actor_id;
    const credentialSlot = row.credential_slot;
    const runId = row.run_id;
    const expectedStep: ProviderCostAnalysisStep | undefined = (() => {
        if (typeof operationKey !== 'string') return undefined;
        if (operationKey === 'profile:target' || operationKey.startsWith('relationship:')) {
            return 'collect';
        }
        if (operationKey.startsWith('profiles:')) return 'profiles';
        if (operationKey.startsWith('interaction:')) return 'interactions';
        return undefined;
    })();
    if (
        typeof operationKey !== 'string'
        || !OPERATION_KEY_PATTERN.test(operationKey)
        || expectedStep === undefined
        || (logicalProvider !== 'apify' && logicalProvider !== 'coderx')
        || typeof actorId !== 'string'
        || !ACTOR_ID_PATTERN.test(actorId)
        || (credentialSlot !== 'primary' && credentialSlot !== 'secondary')
        || row.status !== 'running'
        || typeof runId !== 'string'
        || !RUN_ID_PATTERN.test(runId)
    ) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: stored provider run is invalid.');
    }
    const maxChargeUsd = parseStoredCharge(row.max_charge_usd);
    return {
        operationKey,
        expectedStep,
        logicalProvider,
        actorId,
        credentialSlot,
        maxChargeUsd,
        runId,
    };
}

function terminalUsageTotalUsd(run: ApifyRunSnapshot): number | null {
    if (run.usageTotalUsd === undefined || run.usageTotalUsd === null) return null;
    if (
        typeof run.usageTotalUsd !== 'number'
        || !Number.isFinite(run.usageTotalUsd)
        || run.usageTotalUsd < 0
        || run.usageTotalUsd > MAX_PROVIDER_CHARGE_USD
    ) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: provider terminal usage is invalid.');
    }
    return run.usageTotalUsd;
}

/**
 * Best-effort billing containment before a request is marked terminal. Starting
 * intents have no safe Actor ID and are intentionally left untouched.
 */
export async function abortRunningAnalysisProviderRuns(
    client: ProviderRunClient,
    input: AbortProviderRunsInput,
    deps: AbortProviderRunsDeps = {}
): Promise<number> {
    const { data, error } = await client
        .from('analysis_provider_runs')
        .select(
            'operation_key, logical_provider, actor_id, credential_slot, max_charge_usd, status, run_id'
        )
        .eq('request_id', input.requestId)
        .eq('status', 'running');
    if (error) {
        throw new Error(
            `ANALYSIS_PERSISTENCE_ERROR: provider run abort read failed (${safeErrorCode(error)}).`
        );
    }
    if (!Array.isArray(data) || data.length > MAX_ABORT_RUNS) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: provider run abort set is invalid.');
    }

    // Validate the whole set before performing the first irreversible remote action.
    let runs: StoredRunningProviderRun[];
    try {
        runs = data.map((row) => validateStoredRunningProviderRun(row));
    } catch {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: stored provider run is invalid.');
    }

    for (const stored of runs) {
        const apify = deps.clientForSlot?.(stored.credentialSlot)
            ?? getApifyClient(deps.env ?? process.env, stored.credentialSlot);
        let snapshot: ApifyRunSnapshot;
        try {
            const runClient = apify.run(stored.runId);
            const current = await runClient.get();
            if (!current) {
                throw new Error('missing run');
            }
            snapshot = current;
            let terminalStatus = terminalProviderStatus(snapshot.status);
            if (!terminalStatus) {
                if (snapshot.status === 'READY' || snapshot.status === 'RUNNING') {
                    snapshot = await runClient.abort();
                    terminalStatus = terminalProviderStatus(snapshot.status);
                } else if (snapshot.status !== 'ABORTING' && snapshot.status !== 'TIMING-OUT') {
                    throw new Error('unexpected run state');
                }
                if (!terminalStatus) {
                    snapshot = await runClient.waitForFinish({ waitSecs: ABORT_WAIT_SECS });
                    terminalStatus = terminalProviderStatus(snapshot.status);
                }
            }
            if (!terminalStatus) {
                throw new Error('run did not become terminal');
            }

            await recordAnalysisProviderRunFinished(client, {
                requestId: input.requestId,
                userId: input.userId,
                expectedStep: stored.expectedStep,
                operationKey: stored.operationKey,
                logicalProvider: stored.logicalProvider,
                actorId: stored.actorId,
                credentialSlot: stored.credentialSlot,
                runId: stored.runId,
                maxChargeUsd: stored.maxChargeUsd,
                status: terminalStatus,
                usageTotalUsd: terminalUsageTotalUsd(snapshot),
            });
        } catch {
            throw new Error('ANALYSIS_PERSISTENCE_ERROR: provider run abort could not be confirmed.');
        }
    }
    return runs.length;
}
