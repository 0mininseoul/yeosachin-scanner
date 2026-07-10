import type { AnalysisStep } from './steps';
import type {
    ProviderCostTerminalStatus,
} from '@/lib/services/instagram/providers/types';

export type { ProviderCostTerminalStatus } from '@/lib/services/instagram/providers/types';

const OPERATION_KEY_PATTERN = /^(?:profile:target|profiles:(?:0|[1-9][0-9]{0,6})|relationship:(?:followers|following)|interaction:(?:target_likers|target_comments|candidate_likers):(?:0|[1-9][0-9]{0,6}))$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const MAX_LEDGER_AMOUNT_USD = 100_000;

export type ProviderCostLogicalProvider = 'apify' | 'coderx';
export type ProviderCostCredentialSlot = 'primary' | 'secondary';
export type ProviderCostAnalysisStep = Extract<AnalysisStep, 'collect' | 'profiles' | 'interactions'>;

export interface ProviderCostLedgerRpcClient {
    rpc(
        functionName: string,
        params: Record<string, unknown>
    ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface ProviderCostRunIdentity {
    requestId: string;
    userId: string;
    expectedStep: ProviderCostAnalysisStep;
    operationKey: string;
    logicalProvider: ProviderCostLogicalProvider;
    actorId: string;
    credentialSlot: ProviderCostCredentialSlot;
    runId: string;
    maxChargeUsd: number;
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

function assertAmount(amount: number, label: string): void {
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_LEDGER_AMOUNT_USD) {
        throw new Error(`ANALYSIS_PROVIDER_COST_ERROR: invalid ${label}.`);
    }
}

function assertIdentity(input: ProviderCostRunIdentity): void {
    if (!OPERATION_KEY_PATTERN.test(input.operationKey)) {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: invalid operation key.');
    }
    if (!['collect', 'profiles', 'interactions'].includes(input.expectedStep)) {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: invalid pipeline step.');
    }
    if (!operationMatchesStep(input.operationKey, input.expectedStep)) {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: operation does not match pipeline step.');
    }
    if (input.logicalProvider !== 'apify' && input.logicalProvider !== 'coderx') {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: invalid logical provider.');
    }
    if (!ACTOR_ID_PATTERN.test(input.actorId)) {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: invalid actor id.');
    }
    if (input.credentialSlot !== 'primary' && input.credentialSlot !== 'secondary') {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: invalid credential slot.');
    }
    if (!RUN_ID_PATTERN.test(input.runId)) {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: invalid run id.');
    }
    assertAmount(input.maxChargeUsd, 'maximum charge');
}

function safeErrorCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function rpcIdentity(input: ProviderCostRunIdentity): Record<string, unknown> {
    return {
        p_request_id: input.requestId,
        p_user_id: input.userId,
        p_expected_step: input.expectedStep,
        p_operation_key: input.operationKey,
        p_logical_provider: input.logicalProvider,
        p_actor_id: input.actorId,
        p_credential_slot: input.credentialSlot,
        p_run_id: input.runId,
        p_max_charge_usd: input.maxChargeUsd,
    };
}

export async function recordAnalysisProviderRunStarted(
    client: ProviderCostLedgerRpcClient,
    input: ProviderCostRunIdentity
): Promise<void> {
    assertIdentity(input);
    const { data, error } = await client.rpc(
        'record_analysis_provider_cost_started',
        rpcIdentity(input)
    );
    if (error) {
        throw new Error(
            `ANALYSIS_PROVIDER_COST_ERROR: start write failed (${safeErrorCode(error)}).`
        );
    }
    if (data !== true) {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: request state did not match.');
    }
}

export async function recordAnalysisProviderRunFinished(
    client: ProviderCostLedgerRpcClient,
    input: ProviderCostRunIdentity & {
        status: ProviderCostTerminalStatus;
        usageTotalUsd?: number | null;
    }
): Promise<void> {
    assertIdentity(input);
    if (!['succeeded', 'failed', 'aborted', 'timed_out'].includes(input.status)) {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: invalid terminal status.');
    }
    if (input.usageTotalUsd !== undefined && input.usageTotalUsd !== null) {
        assertAmount(input.usageTotalUsd, 'actual usage');
    }

    const { data, error } = await client.rpc(
        'record_analysis_provider_cost_terminal',
        {
            ...rpcIdentity(input),
            p_status: input.status,
            p_usage_total_usd: input.usageTotalUsd ?? null,
        }
    );
    if (error) {
        throw new Error(
            `ANALYSIS_PROVIDER_COST_ERROR: terminal write failed (${safeErrorCode(error)}).`
        );
    }
    if (data !== true) {
        throw new Error('ANALYSIS_PROVIDER_COST_ERROR: request state did not match.');
    }
}
