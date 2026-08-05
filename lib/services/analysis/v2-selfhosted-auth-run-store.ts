import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_KEY_PATTERN = /^(?:relationship-(?:followers|following)|target-(?:profile|likers|comments)|candidate-likers):[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_CACHED_ITEMS_BYTES = 4 * 1024 * 1024;

export const ANALYSIS_V2_SELFHOSTED_AUTH_RUN_RPC =
    'checkpoint_analysis_v2_selfhosted_auth_run';
export const ANALYSIS_V2_SELFHOSTED_AUTH_RUN_LOAD_RPC =
    'load_analysis_v2_selfhosted_auth_run';

export type AnalysisV2SelfHostedAuthAccountSlot = 'primary';
export type AnalysisV2SelfHostedAuthRunItem = Readonly<Record<string, unknown>>;

export interface AnalysisV2SelfHostedAuthRunCheckpointInput {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
    operationKey: string;
    inputHash: string;
    runId: string;
    accountSlot: AnalysisV2SelfHostedAuthAccountSlot;
    items: readonly AnalysisV2SelfHostedAuthRunItem[];
}

export interface AnalysisV2SelfHostedAuthRunLoadInput {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
    operationKey: string;
    inputHash: string;
}

export interface AnalysisV2SelfHostedAuthRunReceipt {
    schemaVersion: 1;
    provider: 'selfhosted_auth';
    operationKey: string;
    inputHash: string;
    runId: string;
    accountSlot: AnalysisV2SelfHostedAuthAccountSlot;
    items: readonly AnalysisV2SelfHostedAuthRunItem[];
}

interface RpcError {
    code?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2SelfHostedAuthRunSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface AnalysisV2SelfHostedAuthRunStore {
    checkpoint(input: AnalysisV2SelfHostedAuthRunCheckpointInput):
        Promise<AnalysisV2SelfHostedAuthRunReceipt>;
    load(input: AnalysisV2SelfHostedAuthRunLoadInput):
        Promise<AnalysisV2SelfHostedAuthRunReceipt | null>;
}

function validationError(): never {
    throw new Error('ANALYSIS_V2_SELFHOSTED_AUTH_RUN_VALIDATION_ERROR');
}

function persistenceError(): never {
    throw new Error('ANALYSIS_V2_SELFHOSTED_AUTH_RUN_PERSISTENCE_ERROR');
}

function operationMatchesJob(jobKey: string, operationKey: string): boolean {
    if (jobKey === 'track:relationships:collect') {
        return /^relationship-(?:followers|following):[0-9a-f]{64}$/.test(operationKey);
    }
    if (jobKey === 'track:target-evidence:collect') {
        return /^target-(?:profile|likers|comments):[0-9a-f]{64}$/.test(operationKey);
    }
    if (/^track:profiles:batch:\d+$/.test(jobKey)) {
        return /^target-profile:[0-9a-f]{64}$/.test(operationKey);
    }
    if (jobKey === 'track:reverse-likes:collect') {
        return /^candidate-likers:[0-9a-f]{64}$/.test(operationKey);
    }
    return false;
}

/**
 * Scopes the worker-side idempotency ledger to one durable V2 job. The database
 * operation key intentionally remains content-addressed, but forwarding it
 * verbatim would make independent analysis requests share a GCS result forever.
 */
export function createAnalysisV2SelfHostedAuthWorkerIdentity(input: {
    requestId: string;
    jobKey: string;
    operationKey: string;
    inputHash: string;
}): { operationKey: string; inputHash: string } {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !OPERATION_KEY_PATTERN.test(input.operationKey)
        || !SHA256_PATTERN.test(input.inputHash)
        || !operationMatchesJob(input.jobKey, input.operationKey)
    ) {
        validationError();
    }
    const kind = input.operationKey.slice(0, input.operationKey.indexOf(':'));
    const digest = createHash('sha256').update([
        'analysis-v2-selfhosted-auth-worker-operation-v1',
        input.requestId.toLowerCase(),
        input.jobKey,
        input.operationKey,
        input.inputHash,
    ].join('\n'), 'utf8').digest('hex');
    return { operationKey: `${kind}:${digest}`, inputHash: input.inputHash };
}

function maximumItems(operationKey: string): number {
    if (operationKey.startsWith('relationship-')) return 1_200;
    if (operationKey === '' || !OPERATION_KEY_PATTERN.test(operationKey)) return 0;
    if (operationKey.startsWith('target-profile:')) return 1;
    if (operationKey.startsWith('target-comments:')) return 150;
    return 1_500;
}

function isJsonValue(value: unknown): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (typeof value !== 'object') return false;
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/**
 * PostgreSQL JSONB does not preserve object-key insertion order. Compare the
 * semantic payload rather than the transport-specific JSON.stringify order.
 */
function stableJsonStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(item => stableJsonStringify(item)).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).sort().map(key => (
            `${JSON.stringify(key)}:${stableJsonStringify(object[key])}`
        )).join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('ANALYSIS_V2_SELFHOSTED_AUTH_RUN_VALIDATION_ERROR');
    return encoded;
}

function canonicalItems(
    items: unknown,
    operationKey: string,
    onInvalid: () => never
): readonly AnalysisV2SelfHostedAuthRunItem[] {
    if (
        !Array.isArray(items)
        || items.length > maximumItems(operationKey)
        || items.some(item => (
            item === null
            || Array.isArray(item)
            || typeof item !== 'object'
            || Object.getPrototypeOf(item) !== Object.prototype
            || !isJsonValue(item)
        ))
    ) {
        return onInvalid();
    }
    let encoded: string;
    try {
        encoded = JSON.stringify(items);
    } catch {
        return onInvalid();
    }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_CACHED_ITEMS_BYTES) {
        return onInvalid();
    }
    return JSON.parse(encoded) as AnalysisV2SelfHostedAuthRunItem[];
}

function validateClaim(input: AnalysisV2SelfHostedAuthRunLoadInput): void {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !UUID_PATTERN.test(input.claimToken)
        || !SHA256_PATTERN.test(input.jobInputHash)
        || !OPERATION_KEY_PATTERN.test(input.operationKey)
        || !operationMatchesJob(input.jobKey, input.operationKey)
        || !SHA256_PATTERN.test(input.inputHash)
    ) {
        validationError();
    }
}

function validate(input: AnalysisV2SelfHostedAuthRunCheckpointInput): void {
    validateClaim(input);
    if (
        !RUN_ID_PATTERN.test(input.runId)
        || input.accountSlot !== 'primary'
    ) {
        validationError();
    }
    canonicalItems(input.items, input.operationKey, validationError);
}

function parseReceipt(data: unknown): AnalysisV2SelfHostedAuthRunReceipt {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        persistenceError();
    }
    const receipt = data as Record<string, unknown>;
    if (
        receipt.schemaVersion !== 1
        || receipt.provider !== 'selfhosted_auth'
        || typeof receipt.operationKey !== 'string'
        || !OPERATION_KEY_PATTERN.test(receipt.operationKey)
        || typeof receipt.inputHash !== 'string'
        || !SHA256_PATTERN.test(receipt.inputHash)
        || typeof receipt.runId !== 'string'
        || !RUN_ID_PATTERN.test(receipt.runId)
        || receipt.accountSlot !== 'primary'
    ) {
        persistenceError();
    }
    return {
        schemaVersion: 1,
        provider: 'selfhosted_auth',
        operationKey: receipt.operationKey,
        inputHash: receipt.inputHash,
        runId: receipt.runId,
        accountSlot: 'primary',
        items: canonicalItems(receipt.items, receipt.operationKey, persistenceError),
    };
}

export function createAnalysisV2SelfHostedAuthRunStore(
    client: AnalysisV2SelfHostedAuthRunSupabaseClient = supabaseAdmin
): AnalysisV2SelfHostedAuthRunStore {
    return {
        async checkpoint(input) {
            validate(input);
            const items = canonicalItems(input.items, input.operationKey, validationError);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_SELFHOSTED_AUTH_RUN_RPC,
                {
                    p_request_id: input.requestId,
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken,
                    p_job_input_hash: input.jobInputHash,
                    p_operation_key: input.operationKey,
                    p_input_hash: input.inputHash,
                    p_run_id: input.runId,
                    p_account_slot: input.accountSlot,
                    p_items: items,
                }
            );
            if (error) {
                persistenceError();
            }
            const receipt = parseReceipt(data);
            if (
                receipt.operationKey !== input.operationKey
                || receipt.inputHash !== input.inputHash
                || receipt.runId !== input.runId
                || receipt.accountSlot !== input.accountSlot
                || stableJsonStringify(receipt.items) !== stableJsonStringify(items)
            ) {
                throw new Error('ANALYSIS_V2_SELFHOSTED_AUTH_RUN_RESPONSE drift');
            }
            return receipt;
        },
        async load(input) {
            validateClaim(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_SELFHOSTED_AUTH_RUN_LOAD_RPC,
                {
                    p_request_id: input.requestId,
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken,
                    p_job_input_hash: input.jobInputHash,
                    p_operation_key: input.operationKey,
                    p_input_hash: input.inputHash,
                }
            );
            if (error) {
                persistenceError();
            }
            if (data === null) return null;
            const receipt = parseReceipt(data);
            if (
                receipt.operationKey !== input.operationKey
                || receipt.inputHash !== input.inputHash
            ) {
                throw new Error('ANALYSIS_V2_SELFHOSTED_AUTH_RUN_RESPONSE drift');
            }
            return receipt;
        },
    };
}

export const analysisV2SelfHostedAuthRunStore = createAnalysisV2SelfHostedAuthRunStore();
