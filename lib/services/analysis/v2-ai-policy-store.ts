import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { parseAiSchedulerPolicySnapshot } from '@/lib/services/ai/scheduler-policy';
import { aiPolicyVersionSchema } from '@/lib/services/ai/policy-version';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RpcError {
    code?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2AiPolicySupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface AnalysisV2AiPolicyStore {
    loadAiStagePolicyVersion(requestId: string): Promise<string | null>;
    loadRiskPolicyVersion(requestId: string): Promise<string | null>;
    /** The immutable full snapshot is required to opt into scheduler behaviour. */
    loadPolicyVersionsSnapshot?(requestId: string): Promise<Record<string, string> | null>;
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/i.test(error.code)
        ? error.code
        : 'unknown';
}

export function createSupabaseAnalysisV2AiPolicyStore(
    client: AnalysisV2AiPolicySupabaseClient = supabaseAdmin
): AnalysisV2AiPolicyStore {
    const loadVersion = async (requestId: string, rpcName: string): Promise<string | null> => {
        if (!UUID_PATTERN.test(requestId)) {
            throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_VALIDATION_ERROR');
        }
        let response: RpcResult;
        try {
            response = await client.rpc(rpcName, { p_request_id: requestId.toLowerCase() });
        } catch {
            throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: policy load failed (transport).');
        }
        if (response.error) {
            throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: '
                + `policy load failed (${safeRpcCode(response.error)}).`);
        }
        const parsed = aiPolicyVersionSchema.nullable().safeParse(response.data);
        if (!parsed.success) {
            throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: invalid policy response.');
        }
        return parsed.data;
    };
    return {
        async loadAiStagePolicyVersion(requestId) {
            return loadVersion(requestId, 'load_analysis_v2_ai_stage_policy_version');
        },
        async loadRiskPolicyVersion(requestId) {
            return loadVersion(requestId, 'load_analysis_v2_risk_policy_version');
        },
        async loadPolicyVersionsSnapshot(requestId) {
            if (!UUID_PATTERN.test(requestId)) {
                throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_VALIDATION_ERROR');
            }
            let response: RpcResult;
            try {
                response = await client.rpc(
                    'load_analysis_v2_policy_versions_snapshot',
                    { p_request_id: requestId.toLowerCase() },
                );
            } catch {
                throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: policy load failed (transport).');
            }
            if (response.error) {
                throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: '
                    + `policy load failed (${safeRpcCode(response.error)}).`);
            }
            const parsed = z.record(z.string(), aiPolicyVersionSchema)
                .nullable().safeParse(response.data);
            if (!parsed.success) {
                throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: invalid policy response.');
            }
            if (parsed.data) {
                try {
                    parseAiSchedulerPolicySnapshot(parsed.data);
                } catch {
                    throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: invalid policy response.');
                }
            }
            return parsed.data;
        },
    };
}

export const analysisV2AiPolicyStore = createSupabaseAnalysisV2AiPolicyStore();
