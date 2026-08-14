import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const uuidSchema = z.string().uuid();
const ownerRowSchema = z.object({ user_id: uuidSchema }).strict();
const ANALYSIS_RESULT_OPERATOR_EMAIL = 'ym1113@kakao.com';
type AnalysisResultPipelineVersion = 'v1' | 'v2';

interface AuthenticatedResultViewer {
    id: string;
    email?: string;
}

interface ResultOwnerLookupClient {
    from(table: 'analysis_requests'): {
        select(columns: 'user_id'): {
            eq(column: 'id', value: string): {
                eq(column: 'pipeline_version', value: AnalysisResultPipelineVersion): {
                    eq(column: 'status', value: 'completed'): {
                        maybeSingle(): PromiseLike<{
                            data: unknown;
                            error: unknown;
                        }>;
                    };
                };
            };
        };
    };
}

/** Server-side only: Supabase has already authenticated this user object. */
export function isAnalysisResultOperator(viewer: AuthenticatedResultViewer): boolean {
    if (!uuidSchema.safeParse(viewer.id).success || !viewer.email) return false;
    return viewer.email.trim().toLowerCase() === ANALYSIS_RESULT_OPERATOR_EMAIL;
}

/** Resolves the owner only after the route has authorized the operator. */
export function resolveAnalysisResultOwner(
    requestId: string,
    client?: ResultOwnerLookupClient,
): Promise<string | null>;
export function resolveAnalysisResultOwner(
    requestId: string,
    pipelineVersion: AnalysisResultPipelineVersion,
    client?: ResultOwnerLookupClient,
): Promise<string | null>;
export async function resolveAnalysisResultOwner(
    requestId: string,
    pipelineOrClient: AnalysisResultPipelineVersion | ResultOwnerLookupClient = 'v2',
    maybeClient?: ResultOwnerLookupClient,
): Promise<string | null> {
    if (!uuidSchema.safeParse(requestId).success) return null;
    const pipelineVersion = typeof pipelineOrClient === 'string' ? pipelineOrClient : 'v2';
    const client = (typeof pipelineOrClient === 'string' ? maybeClient : pipelineOrClient)
        ?? (supabaseAdmin as unknown as ResultOwnerLookupClient);
    const { data, error } = await client
        .from('analysis_requests')
        .select('user_id')
        .eq('id', requestId)
        .eq('pipeline_version', pipelineVersion)
        .eq('status', 'completed')
        .maybeSingle();
    if (error) throw new Error('ANALYSIS_RESULT_OPERATOR_LOOKUP_FAILED');
    const parsed = ownerRowSchema.safeParse(data);
    return parsed.success ? parsed.data.user_id : null;
}
