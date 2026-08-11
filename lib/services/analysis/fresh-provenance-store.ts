import 'server-only';

import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const JOB_KEY = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const PROVIDER_OPERATION_KEY = /^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[a-f0-9]{64}$/;
const APIFY_ID = /^[A-Za-z0-9]{8,128}$/;

export interface FreshProvenanceRpcClient {
    rpc(functionName: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { code?: string; message?: string } | null;
    }>;
}

export interface FreshProviderEvidenceIdentity {
    readonly requestId: string;
    readonly jobKey: string;
    readonly jobClaimToken: string;
    readonly jobInputHash: string;
    readonly operationKey: string;
    readonly providerInputHash: string;
    /** Raw IDs only cross the in-process callback boundary; they are hashed before RPC. */
    readonly runId: string;
}

export interface FreshProviderDatasetBinding extends FreshProviderEvidenceIdentity {
    /** Raw Apify dataset id only; it is never persisted or sent to the RPC. */
    readonly datasetId: string;
}

export interface FreshProvenanceOutcome {
    readonly disposition: 'admitted' | 'recorded' | 'bound';
    readonly created: boolean;
    readonly replayed: boolean;
}

export interface FreshProvenanceBoundedSummary {
    readonly providerRunCount: number;
    readonly datasetBoundCount: number;
    readonly allLive: boolean;
}

export class FreshProvenanceStoreError extends Error {
    constructor(readonly code:
        | 'INVALID_INPUT'
        | 'FENCE'
        | 'DRIFT'
        | 'NOT_FRESH'
        | 'INVALID_RESPONSE'
        | 'RPC_FAILED'
    ) {
        super(`FRESH_PROVENANCE_${code}`);
        this.name = 'FreshProvenanceStoreError';
    }
}

function opaqueHash(domain: string, values: readonly string[]): string {
    const material = [domain, ...values.map(value => `${Buffer.byteLength(value, 'utf8')}:${value}`)]
        .join('|');
    return createHash('sha256').update(material, 'utf8').digest('hex');
}

/** Stable locally-derived opaque identity for the exact provider source row. */
export function freshProviderRunHash(input: FreshProviderEvidenceIdentity): string {
    return opaqueHash('analysis-revenue-fresh-provider-run/v1', [
        input.requestId.toLowerCase(), input.jobKey, input.operationKey, input.runId,
    ]);
}

/** Stable locally-derived opaque identity for one exact dataset under that source row. */
export function freshProviderDatasetHash(input: FreshProviderDatasetBinding): string {
    return opaqueHash('analysis-revenue-fresh-provider-dataset/v1', [
        input.requestId.toLowerCase(), input.jobKey, input.operationKey, input.runId,
        input.datasetId,
    ]);
}

function assertIdentity(input: FreshProviderEvidenceIdentity): void {
    if (
        !UUID.test(input.requestId)
        || !JOB_KEY.test(input.jobKey)
        || !UUID.test(input.jobClaimToken)
        || !HASH.test(input.jobInputHash)
        || !PROVIDER_OPERATION_KEY.test(input.operationKey)
        || !HASH.test(input.providerInputHash)
        || !APIFY_ID.test(input.runId)
    ) throw new FreshProvenanceStoreError('INVALID_INPUT');
}

function rpcObject(data: unknown): Record<string, unknown> {
    const value = Array.isArray(data) && data.length === 1 ? data[0] : data;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new FreshProvenanceStoreError('INVALID_RESPONSE');
    }
    return value as Record<string, unknown>;
}

function parseOutcome(data: unknown, disposition: FreshProvenanceOutcome['disposition']): FreshProvenanceOutcome {
    const row = rpcObject(data);
    if (
        row.disposition !== disposition
        || typeof row.created !== 'boolean'
        || typeof row.replayed !== 'boolean'
        || (row.created && row.replayed)
    ) throw new FreshProvenanceStoreError('INVALID_RESPONSE');
    return Object.freeze({
        disposition,
        created: row.created,
        replayed: row.replayed,
    });
}

function parseSummary(data: unknown): FreshProvenanceBoundedSummary {
    const row = rpcObject(data);
    if (
        !Number.isSafeInteger(row.providerRunCount)
        || (row.providerRunCount as number) < 0
        || (row.providerRunCount as number) > 128
        || !Number.isSafeInteger(row.datasetBoundCount)
        || (row.datasetBoundCount as number) < 0
        || (row.datasetBoundCount as number) > (row.providerRunCount as number)
        || typeof row.allLive !== 'boolean'
    ) throw new FreshProvenanceStoreError('INVALID_RESPONSE');
    return Object.freeze({
        providerRunCount: row.providerRunCount as number,
        datasetBoundCount: row.datasetBoundCount as number,
        allLive: row.allLive,
    });
}

function safeRpcError(error: { code?: string; message?: string }): FreshProvenanceStoreError {
    if (error.code === 'P0001') {
        if (error.message === 'FRESH_PROVENANCE_FENCE') return new FreshProvenanceStoreError('FENCE');
        if (error.message === 'FRESH_PROVENANCE_DRIFT') return new FreshProvenanceStoreError('DRIFT');
        if (error.message === 'FRESH_PROVENANCE_NOT_FRESH') return new FreshProvenanceStoreError('NOT_FRESH');
    }
    return new FreshProvenanceStoreError('RPC_FAILED');
}

export class FreshProvenanceStore {
    constructor(private readonly client: FreshProvenanceRpcClient = supabaseAdmin) {}

    async assertProviderAdmission(input: Omit<FreshProviderEvidenceIdentity, 'runId'>): Promise<FreshProvenanceOutcome> {
        assertIdentity({ ...input, runId: 'Provider1' });
        return this.call('assert_analysis_revenue_fresh_provider_admission_v1', {
            p_request_id: input.requestId.toLowerCase(),
            p_job_key: input.jobKey,
            p_job_claim_token: input.jobClaimToken.toLowerCase(),
            p_job_input_hash: input.jobInputHash,
            p_operation_key: input.operationKey,
            p_provider_input_hash: input.providerInputHash,
        }, 'admitted');
    }

    async recordProviderRun(input: FreshProviderEvidenceIdentity): Promise<FreshProvenanceOutcome> {
        assertIdentity(input);
        return this.call('record_analysis_revenue_fresh_provider_evidence_v1', {
            p_request_id: input.requestId.toLowerCase(),
            p_job_key: input.jobKey,
            p_job_claim_token: input.jobClaimToken.toLowerCase(),
            p_job_input_hash: input.jobInputHash,
            p_operation_key: input.operationKey,
            p_provider_input_hash: input.providerInputHash,
            p_provider_run_hash: freshProviderRunHash(input),
        }, 'recorded');
    }

    async bindProviderDataset(input: FreshProviderDatasetBinding): Promise<FreshProvenanceOutcome> {
        assertIdentity(input);
        if (!APIFY_ID.test(input.datasetId)) throw new FreshProvenanceStoreError('INVALID_INPUT');
        return this.call('bind_analysis_revenue_fresh_provider_dataset_v1', {
            p_request_id: input.requestId.toLowerCase(),
            p_job_key: input.jobKey,
            p_job_claim_token: input.jobClaimToken.toLowerCase(),
            p_job_input_hash: input.jobInputHash,
            p_operation_key: input.operationKey,
            p_provider_input_hash: input.providerInputHash,
            p_provider_run_hash: freshProviderRunHash(input),
            p_provider_dataset_hash: freshProviderDatasetHash(input),
        }, 'bound');
    }

    async readBoundedSummary(input: Omit<FreshProviderEvidenceIdentity, 'runId' | 'providerInputHash'>): Promise<FreshProvenanceBoundedSummary> {
        if (
            !UUID.test(input.requestId)
            || !JOB_KEY.test(input.jobKey)
            || !UUID.test(input.jobClaimToken)
            || !HASH.test(input.jobInputHash)
            || !PROVIDER_OPERATION_KEY.test(input.operationKey)
        ) throw new FreshProvenanceStoreError('INVALID_INPUT');
        const { data, error } = await this.client.rpc(
            'read_analysis_revenue_fresh_provider_evidence_summary_v1',
            {
                p_request_id: input.requestId.toLowerCase(),
                p_job_key: input.jobKey,
                p_job_claim_token: input.jobClaimToken.toLowerCase(),
                p_job_input_hash: input.jobInputHash,
                p_operation_key: input.operationKey,
            }
        );
        if (error) throw safeRpcError(error);
        return parseSummary(data);
    }

    private async call(
        functionName: string,
        params: Record<string, unknown>,
        disposition: FreshProvenanceOutcome['disposition']
    ): Promise<FreshProvenanceOutcome> {
        const { data, error } = await this.client.rpc(functionName, params);
        if (error) throw safeRpcError(error);
        return parseOutcome(data, disposition);
    }
}

export const analysisRevenueFreshProvenanceStore = new FreshProvenanceStore();
