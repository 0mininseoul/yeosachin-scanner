import 'server-only';

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { APIFY_CREDENTIAL_SLOTS } from '@/lib/services/instagram/providers/types';
import { INSTAGRAM_USERNAME_PATTERN } from '@/lib/services/instagram/username';
import { currentDevStandardArchive, DevStandardArchiveError } from '@/lib/services/dev-ui/standard-archive-runtime';
import type { AnalysisV2CollectionJobClaim } from './v2-request-context';
import type {
    AnalysisV2RelationshipRowInput,
    AnalysisV2TargetEvidenceRowInput,
    AnalysisV2TargetEvidenceSourceInput,
} from './v2-evidence-store';
import {
    analysisV2CheckpointResultSchema,
    type AnalysisV2ProfileAttemptResultInput,
} from './v2-profile-fetch-store';
import { ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY } from './v2-coordinator';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const username = z.string().regex(INSTAGRAM_USERNAME_PATTERN);
const operationKey = z.string().regex(/^[a-z][a-z0-9-]+:[a-f0-9]{64}$/);
const providerRunId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const archivedCollectedSource = z.object({
    status: z.literal('collected'),
    inputHash: hash,
    provider: z.literal('apify'),
    providerRunId,
    providerOperationKey: operationKey,
});
const archivedEmptySource = z.object({
    status: z.literal('not_applicable'),
    inputHash: hash,
    provider: z.null(),
    providerRunId: z.null(),
    providerOperationKey: z.null(),
});
const relationshipFields = {
    coverageBps: z.number().int().min(0).max(10_000),
    rows: z.array(z.object({
        username, isPrivate: z.boolean(), isVerified: z.boolean(),
        fullName: z.string().nullable(), profilePicUrl: z.string().nullable(),
    }).strict()).max(50_000),
};
const relationshipSchema = z.discriminatedUnion('status', [
    archivedCollectedSource.extend(relationshipFields).strict(),
    archivedEmptySource.extend(relationshipFields).strict(),
]);
const targetCoverage = z.array(z.object({
    postId: z.string(),
    declaredCount: z.number().int().nonnegative(),
    returnedCount: z.number().int().nonnegative(),
    requestedLimit: z.number().int().positive(),
}).strict()).max(6);
const targetSourceSchema = z.discriminatedUnion('status', [
    archivedCollectedSource.extend({ coverage: targetCoverage.min(1) }).strict(),
    archivedEmptySource.extend({ coverage: z.tuple([]) }).strict(),
]);
const targetEvidenceSchema = z.object({
    likerSource: targetSourceSchema,
    commentSource: targetSourceSchema,
    rows: z.array(z.object({
        actorUsername: username,
        postId: z.string(),
        signal: z.enum(['target_post_like', 'target_post_comment']),
        sourceInteractionId: z.string(),
        occurredAt: z.string().nullable(),
        content: z.string().nullable(),
    }).strict()).max(2_000),
}).strict();
const profileProofSchema = z.object({ providerOperationKey: operationKey, providerInputHash: hash }).strict();
const archivedProfileBatch = z.array(analysisV2CheckpointResultSchema).min(1).max(32);

type Identity = readonly (string | number | boolean | null)[];
type ArchivedTargetSource = z.infer<typeof targetSourceSchema>;

async function read<T>(kind: string, identity: Identity, schema: z.ZodType<T>): Promise<T> {
    const archive = currentDevStandardArchive();
    if (archive?.mode !== 'replay') throw new DevStandardArchiveError();
    const parsed = schema.safeParse(await archive.load(kind, identity));
    if (!parsed.success) return archive.fail();
    return parsed.data;
}

export async function readDevStandardArchivedRelationship(input: {
    target: string;
    side: 'followers' | 'following';
    declaredCount: number;
    allowedInputHashes: ReadonlySet<string>;
}): Promise<{
    source: { status: 'not_applicable'; inputHash: string }
        | z.infer<typeof archivedCollectedSource>;
    rows: readonly AnalysisV2RelationshipRowInput[];
}> {
    const data = await read(
        'relationship-side-v1', [input.target, input.side, input.declaredCount, 'standard'], relationshipSchema,
    );
    if (!input.allowedInputHashes.has(data.inputHash)
        || (data.status === 'not_applicable') !== (input.declaredCount === 0)
        || (data.status === 'not_applicable' && data.rows.length !== 0)) throw new DevStandardArchiveError();
    const { coverageBps, rows, ...source } = data;
    void coverageBps;
    return {
        source: source.status === 'not_applicable'
            ? { status: source.status, inputHash: source.inputHash }
            : source,
        rows,
    };
}

async function targetSource(
    claim: AnalysisV2CollectionJobClaim,
    record: ArchivedTargetSource,
    expectedHash: string,
    expectedOperationKey: string | null,
): Promise<AnalysisV2TargetEvidenceSourceInput> {
    if (record.inputHash !== expectedHash
        || (record.status === 'not_applicable') !== (expectedOperationKey === null)) {
        throw new DevStandardArchiveError();
    }
    if (record.status === 'not_applicable') return { status: record.status, inputHash: record.inputHash };
    if (record.providerOperationKey !== expectedOperationKey) throw new DevStandardArchiveError();

    const { error, data } = await supabaseAdmin.rpc('dev_live_standard_archive_evidence_slot_v1', {
        p_request_id: claim.requestId,
        p_job_key: claim.jobKey,
        p_claim_token: claim.claimToken,
        p_job_input_hash: claim.jobInputHash,
        p_operation_key: record.providerOperationKey,
        p_input_hash: record.inputHash,
        p_run_id: record.providerRunId,
    });
    const slot = z.enum(APIFY_CREDENTIAL_SLOTS).safeParse(data);
    if (error || !slot.success) throw new DevStandardArchiveError();
    return { ...record, providerCredentialSlot: slot.data };
}

export async function readDevStandardArchivedTargetEvidence(input: {
    claim: AnalysisV2CollectionJobClaim;
    key: Identity;
    likerHash: string;
    commenterHash: string;
    likerOperationKey: string | null;
    commenterOperationKey: string | null;
}): Promise<{
    rows: AnalysisV2TargetEvidenceRowInput[];
    likerSource: AnalysisV2TargetEvidenceSourceInput;
    commentSource: AnalysisV2TargetEvidenceSourceInput;
}> {
    const data = await read('target-evidence-v1', input.key, targetEvidenceSchema);
    const [likerSource, commentSource] = await Promise.all([
        targetSource(input.claim, data.likerSource, input.likerHash, input.likerOperationKey),
        targetSource(input.claim, data.commentSource, input.commenterHash, input.commenterOperationKey),
    ]);

    return {
        likerSource,
        commentSource,
        rows: data.rows.map(({ occurredAt, content, ...row }) => ({
            ...row,
            ...(occurredAt === null ? {} : { occurredAt }),
            ...(content === null ? {} : { content }),
        })),
    };
}

export async function readDevStandardArchivedProfiles(input: {
    target: string;
    jobKey: string;
    batch: number | null;
    usernames: readonly string[];
}): Promise<{
    results: AnalysisV2ProfileAttemptResultInput[];
    providerOperationKey: string;
    providerInputHash: string;
}> {
    const proof = await read('source-profile-proof-v1', [
        input.target, input.jobKey, ...input.usernames,
    ], profileProofSchema);

    if (input.jobKey === ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY) {
        const result = await read('formal-target-profile-v2', [input.target], analysisV2CheckpointResultSchema);
        if (!('profile' in result) || result.outcome.status !== 'success' || result.outcome.source !== 'apify'
            || result.profile.username !== input.target || input.usernames.length !== 1
            || input.usernames[0] !== result.profile.username || result.profile.isPrivate) throw new DevStandardArchiveError();
        return { ...proof, results: [result] };
    }
    if (input.batch === null) throw new DevStandardArchiveError();
    const results = await read('candidate-profile-batch-v1', [
        input.target, input.batch, ...input.usernames,
    ], archivedProfileBatch);
    if (results.length !== input.usernames.length || results.some((result, index) => (
        result.outcome.requestedUsername !== input.usernames[index] || result.outcome.source !== 'apify'
    ))) throw new DevStandardArchiveError();
    return { ...proof, results };
}
