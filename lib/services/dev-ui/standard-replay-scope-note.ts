import { isPostgresLockTimeout, isPostgresStatementTimeout, retryPostgresAbortedRpc } from '@/lib/supabase/rpc-retry';
import { DevStandardArchiveStorageRetryError } from './standard-archive-store';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { replayScopeDeltaSchema, type ReplayScopeDelta } from '@/lib/contracts/dev-standard-replay';

export async function checkpointDevReplayScope(
    claim: { requestId: string; claimToken: string; jobInputHash: string },
    delta?: ReplayScopeDelta,
): Promise<void> {
    const counts = delta === undefined ? { added: 0, removed: 0, unverified: 0 } : replayScopeDeltaSchema.parse(delta);
    const { data, error } = await retryPostgresAbortedRpc(() => supabaseAdmin.rpc('checkpoint_dev_standard_replay_scope_note_v1', {
        p_request_id: claim.requestId, p_claim_token: claim.claimToken, p_job_input_hash: claim.jobInputHash,
        p_added: counts.added, p_removed: counts.removed, p_unverified: counts.unverified,
    }), { retryLockTimeout: true });
    if (isPostgresStatementTimeout(error) || isPostgresLockTimeout(error) || error?.code === '40P01') {
        throw new DevStandardArchiveStorageRetryError();
    }
    if (error || data !== true) throw new Error('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
}

export async function readDevReplayScope(requestId: string, ownerId: string): Promise<ReplayScopeDelta | null> {
    const { data, error } = await supabaseAdmin.rpc('read_dev_standard_replay_scope_note_v1', {
        p_request_id: requestId, p_user_id: ownerId,
    });
    if (error) throw new Error('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
    return replayScopeDeltaSchema.nullable().parse(data);
}
