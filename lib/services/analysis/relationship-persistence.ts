import type { InstagramFollower } from '@/lib/types/instagram';

interface RelationshipCheckpointRpcResult {
    data: unknown;
    error: { code?: string } | null;
}

export interface RelationshipCheckpointRpcClient {
    rpc(
        functionName: string,
        params: Record<string, unknown>
    ): PromiseLike<RelationshipCheckpointRpcResult>;
}

function safeErrorCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

export async function checkpointRelationshipList(
    client: RelationshipCheckpointRpcClient,
    input: {
        requestId: string;
        userId: string;
        kind: 'followers' | 'following';
        rows: InstagramFollower[];
    }
): Promise<void> {
    const { data, error } = await client.rpc('checkpoint_analysis_relationship_list', {
        p_request_id: input.requestId,
        p_user_id: input.userId,
        p_kind: input.kind,
        p_rows: input.rows,
    });
    if (error) {
        throw new Error(
            `ANALYSIS_PERSISTENCE_ERROR: relationship checkpoint failed (${safeErrorCode(error)}).`
        );
    }
    if (data !== true) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: relationship request state did not match.');
    }
}
