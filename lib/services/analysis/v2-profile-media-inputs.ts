import { z } from 'zod';
import { MAX_FEATURE_MEDIA, MAX_TRIAGE_MEDIA, type SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import { ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS } from '@/lib/services/ai/image-preprocessing';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { retryPostgresAbortedRpc } from '@/lib/supabase/rpc-retry';
import { AnalysisV2JobFenceError } from './v2-job-store';
import { ANALYSIS_V2_PROFILE_BATCH_LIMIT } from './v2-dag-planner';
import type { ProfileGenderPlanFence } from './v2-profile-gender-plan';
import type { normalizeAnalysisV2MediaSelections } from './v2-media-normalization';
import { analysisV2SourceMediaArchiveId, type AnalysisV2SourceMediaArchiveStore } from './v2-source-media-archive';

const failureSchema = z.object({
    index: z.number().int().min(0).max(MAX_FEATURE_MEDIA - 1),
    reason: z.enum(ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS),
    disposition: z.enum(['transient', 'permanent']),
}).strict();
const mediaInputSchema = z.object({
    ordinal: z.number().int().min(0).max(ANALYSIS_V2_PROFILE_BATCH_LIMIT - 1),
    stage: z.enum(['triage', 'feature_remainder']),
    selectedCount: z.number().int().min(0).max(MAX_FEATURE_MEDIA),
    failures: z.array(failureSchema).max(MAX_FEATURE_MEDIA),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    operationKey: z.string().regex(/^feature-analysis:[a-f0-9]{64}$/).nullable(),
}).strict().refine(row => {
    const indices = row.failures.map(failure => failure.index);
    return indices.every((index, i) => index < row.selectedCount && (i === 0 || index > indices[i - 1]!))
        && (row.archiveSha256 === null) === (row.selectedCount === indices.length)
        && (row.stage !== 'triage' || (row.operationKey === null && row.selectedCount <= MAX_TRIAGE_MEDIA));
});
const loadedSchema = z.object({
    inputs: z.array(mediaInputSchema).max(2 * ANALYSIS_V2_PROFILE_BATCH_LIMIT),
    hasGenderHistory: z.boolean(),
    hasUnownedFeatureHistory: z.boolean(),
}).strict();
export type ProfileMediaInput = z.infer<typeof mediaInputSchema>;
export interface ProfileMediaInputStore {
    load(fence: ProfileGenderPlanFence): Promise<z.infer<typeof loadedSchema>>;
    pin(fence: ProfileGenderPlanFence, inputs: readonly ProfileMediaInput[]): Promise<void>;
}
type PreparedMedia = Awaited<ReturnType<typeof normalizeAnalysisV2MediaSelections>>;

const PROFILE_FEATURE_HISTORY_PENDING = 'ANALYSIS_V2_PROFILE_FEATURE_HISTORY_PENDING';

export class DeferredProfileFeatureInput extends Error {
    constructor(readonly receipt: ProfileMediaInput) {
        super(PROFILE_FEATURE_HISTORY_PENDING);
    }
}

function drift(): never {
    throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT');
}
async function mediaRpc(name: string, fence: ProfileGenderPlanFence, extra: Record<string, unknown> = {}) {
    const { data, error } = await retryPostgresAbortedRpc(() => supabaseAdmin.rpc(name, {
        p_request_id: fence.requestId, p_job_key: fence.jobKey, p_claim_token: fence.claimToken,
        p_input_hash: fence.inputHash, ...extra,
    }));
    if (!error) return data;
    switch (error.message) {
    case PROFILE_FEATURE_HISTORY_PENDING: throw new Error(PROFILE_FEATURE_HISTORY_PENDING);
    case 'ANALYSIS_V2_PROFILE_GENDER_PLAN_FENCE_MISMATCH': throw new AnalysisV2JobFenceError();
    case 'ANALYSIS_V2_PROFILE_GENDER_PLAN_POLICY_MISMATCH': throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
    case 'ANALYSIS_V2_PROFILE_GENDER_PLAN_INVALID':
    case 'ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT': return drift();
    default: throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_PERSISTENCE_ERROR');
    }
}

export const profileMediaInputStore: ProfileMediaInputStore = {
    async load(fence) {
        const data = await mediaRpc('load_analysis_v2_profile_media_inputs', fence);
        const parsed = loadedSchema.safeParse(data);
        if (!parsed.success) drift();
        const keys = parsed.data.inputs.map(row => `${row.ordinal}:${row.stage}`);
        if (new Set(keys).size !== keys.length) drift();
        return parsed.data;
    },
    async pin(fence, inputs) {
        if (!inputs.length) return;
        const accepted = await mediaRpc('pin_analysis_v2_profile_media_inputs', fence, { p_inputs: inputs });
        if (accepted !== true) drift();
    },
};

export function profileMediaReceipt(
    ordinal: number, stage: ProfileMediaInput['stage'], selected: readonly SelectedAnalysisMedia[],
    normalized: PreparedMedia, archiveSha256: string | null, operationKey: string | null,
): ProfileMediaInput {
    const failures = normalized.coverage.failures.map(({ selectionId, reason, disposition }) => ({
        index: selected.findIndex(item => item.selectionId === selectionId), reason, disposition,
    }));
    const parsed = mediaInputSchema.safeParse({
        ordinal, stage, selectedCount: selected.length, failures, archiveSha256, operationKey,
    });
    if (!parsed.success) drift();
    const failed = new Set(failures.map(row => row.index));
    const successful = selected.filter((_, index) => !failed.has(index));
    if (normalized.media.length !== successful.length
        || normalized.media.some((row, index) => row.selectionId !== successful[index]!.selectionId)) drift();
    return parsed.data;
}

export async function restoreProfileMedia(
    receipt: ProfileMediaInput, selected: readonly SelectedAnalysisMedia[], candidateId: string,
    requestId: string, archive: AnalysisV2SourceMediaArchiveStore,
): Promise<PreparedMedia> {
    if (receipt.selectedCount !== selected.length) drift();
    const failures = receipt.failures.map(({ index, reason, disposition }) => ({
        selectionId: selected[index]?.selectionId ?? drift(), reason, disposition,
    }));
    const failed = new Set(receipt.failures.map(row => row.index));
    const successful = selected.filter((_, index) => !failed.has(index));
    const rows = receipt.archiveSha256 === null ? [] : await archive.loadBundle({
        requestId, archiveId: analysisV2SourceMediaArchiveId({ candidateId, stage: receipt.stage }),
        contentSha256: receipt.archiveSha256, expectedSelectionIds: successful.map(row => row.selectionId),
    });
    if (!rows || rows.length !== successful.length
        || rows.some((row, index) => row.selectionId !== successful[index]!.selectionId)) drift();
    const bytes = new Map(rows.map(row => [row.selectionId, row.normalizedJpeg]));
    return {
        media: successful.map((row, index) => ({
            selectionId: row.selectionId, kind: row.role === 'profile' ? 'profile' : 'feed',
            normalizedJpegBase64: rows[index]!.normalizedJpeg.toString('base64'),
            ...(row.postId ? { postId: row.postId } : {}),
        })),
        bytes, coverage: { selectedCount: selected.length, normalizedCount: rows.length, failures },
    };
}

export function persistProfileMedia(
    normalized: PreparedMedia, requestId: string, candidateId: string, stage: ProfileMediaInput['stage'],
    archive: AnalysisV2SourceMediaArchiveStore,
): Promise<string | null> {
    if (!normalized.media.length) return Promise.resolve(null);
    return archive.persistBundle({
        requestId, archiveId: analysisV2SourceMediaArchiveId({ candidateId, stage }),
        media: normalized.media.map(row => ({
            selectionId: row.selectionId, normalizedJpeg: normalized.bytes.get(row.selectionId) ?? drift(),
        })),
    });
}

/** Seal the exact feature input before starting either the feature model or its optional resolver. */
export async function pinProfileFeatureMedia(input: {
    ordinal: number;
    candidateId: string;
    selected: readonly SelectedAnalysisMedia[];
    normalized: PreparedMedia;
    saved?: ProfileMediaInput;
    deferred?: ProfileMediaInput;
    fence: ProfileGenderPlanFence;
    store: ProfileMediaInputStore | null;
    archive: AnalysisV2SourceMediaArchiveStore;
}, operationKey: string | null, archiveForLegacy: boolean): Promise<string | null> {
    const previous = input.saved ?? input.deferred;
    if (previous && previous.operationKey !== operationKey) drift();
    if (input.saved) return input.saved.archiveSha256;
    if (!input.store && !archiveForLegacy) return null;
    const digest = input.deferred ? input.deferred.archiveSha256 : await persistProfileMedia(
        input.normalized, input.fence.requestId, input.candidateId, 'feature_remainder', input.archive,
    );
    if (input.store) {
        const receipt = input.deferred ?? profileMediaReceipt(
            input.ordinal, 'feature_remainder', input.selected, input.normalized, digest, operationKey,
        );
        try {
            await input.store.pin(input.fence, [receipt]);
        } catch (error) {
            if (!(error instanceof Error) || error.message !== PROFILE_FEATURE_HISTORY_PENDING) throw error;
            if (input.deferred) drift();
            throw new DeferredProfileFeatureInput(receipt);
        }
    }
    return digest;
}
