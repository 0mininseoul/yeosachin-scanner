import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

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
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/i.test(error.code)
        ? error.code
        : 'unknown';
}

export function createSupabaseAnalysisV2AiPolicyStore(
    client: AnalysisV2AiPolicySupabaseClient = supabaseAdmin
): AnalysisV2AiPolicyStore {
    return {
        async loadAiStagePolicyVersion(requestId) {
            if (!UUID_PATTERN.test(requestId)) {
                throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_VALIDATION_ERROR');
            }
            let response: RpcResult;
            try {
                response = await client.rpc(
                    'load_analysis_v2_ai_stage_policy_version',
                    { p_request_id: requestId.toLowerCase() }
                );
            } catch {
                throw new Error(
                    'ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: '
                    + 'policy load failed (transport).'
                );
            }
            const { data, error } = response;
            if (error) {
                throw new Error(
                    'ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: '
                    + `policy load failed (${safeRpcCode(error)}).`
                );
            }
            const parsed = z.string().regex(VERSION_PATTERN).nullable().safeParse(data);
            if (!parsed.success) {
                throw new Error(
                    'ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: '
                    + 'invalid policy response.'
                );
            }
            return parsed.data;
        },
    };
}

export const analysisV2AiPolicyStore = createSupabaseAnalysisV2AiPolicyStore();
