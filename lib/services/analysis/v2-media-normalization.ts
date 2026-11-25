import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import {
    ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS,
    classifyAnalysisImagePreparationError,
    type AnalysisImagePreparationFailureDisposition,
    type AnalysisImagePreparationFailureReason,
} from '@/lib/services/ai/image-preprocessing';
import {
    aiStagePolicySupports,
    assertSupportedAiStagePolicyVersion,
} from '@/lib/services/ai/stage-policy';
import type { NormalizedAiMediaSelection } from '@/lib/services/ai/v2-staged-analysis';
import { currentDevStandardArchive, DevStandardArchiveError } from '@/lib/services/dev-ui/standard-archive-runtime';
import { archiveMediaUrlAnchor } from '@/lib/services/dev-ui/standard-archive-media-identity';
import { ANALYSIS_V2_MEDIA_ARTIFACT_MAX_BYTES } from './v2-media-artifact-store';

export const ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS = 2;

export interface AnalysisV2ProfileMediaCoverage {
    selectedCount: number;
    normalizedCount: number;
    failures: readonly Readonly<{
        selectionId: string;
        reason: AnalysisImagePreparationFailureReason;
        disposition: AnalysisImagePreparationFailureDisposition;
    }>[];
}

export function isAnalysisV2PartialMediaCoverageAllowed(
    coverage: AnalysisV2ProfileMediaCoverage,
): boolean {
    return coverage.normalizedCount >= 1
        && coverage.failures.length * 5 <= coverage.selectedCount;
}

export class AnalysisV2TransientMediaPreparationError extends Error {
    constructor() {
        super('ANALYSIS_V2_MEDIA_PREPARATION_TRANSIENT');
        this.name = 'AnalysisV2TransientMediaPreparationError';
    }
}

function supportsPartialMediaCoverage(version: string): boolean {
    try {
        return aiStagePolicySupports(
            assertSupportedAiStagePolicyVersion(version),
            'partialMediaCoverage',
        );
    } catch {
        return false;
    }
}

type PreparedMedia = {
    status: 'success';
    item: SelectedAnalysisMedia;
    bytes: Buffer;
} | {
    status: 'failure';
    item: SelectedAnalysisMedia;
    failure: AnalysisV2ProfileMediaCoverage['failures'][number];
};

const archiveMediaSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('success'),
        jpeg: z.string()
            .min(8)
            .max(Math.ceil(ANALYSIS_V2_MEDIA_ARTIFACT_MAX_BYTES / 3) * 4),
    }).strict(),
    z.object({
        status: z.literal('failure'),
        reason: z.enum(ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS),
        disposition: z.enum(['transient', 'permanent']),
    }).strict(),
]);

async function prepareMedia(
    item: SelectedAnalysisMedia,
    normalize: (item: SelectedAnalysisMedia) => Promise<Buffer>,
): Promise<PreparedMedia> {
    for (let attempt = 1; attempt <= ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS; attempt++) {
        try {
            return { status: 'success', item, bytes: await normalize(item) };
        } catch (error) {
            if (error instanceof DevStandardArchiveError) throw error;
            const failure = classifyAnalysisImagePreparationError(error, 'download');
            if (
                failure.disposition === 'transient'
                && attempt < ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS
            ) continue;
            return {
                status: 'failure',
                item,
                failure: {
                    selectionId: item.selectionId,
                    reason: failure.reason,
                    disposition: failure.disposition,
                },
            };
        }
    }
    throw new Error('ANALYSIS_V2_MEDIA_PREPARATION_ATTEMPT_DRIFT');
}

function validJpeg(bytes: Buffer): boolean {
    return bytes.length >= 4
        && bytes.length <= ANALYSIS_V2_MEDIA_ARTIFACT_MAX_BYTES
        && bytes[0] === 0xff && bytes[1] === 0xd8
        && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

function archiveMediaValue(prepared: PreparedMedia, fail: () => never) {
    if (prepared.status === 'success') {
        if (!validJpeg(prepared.bytes)) return fail();
        return { status: prepared.status, jpeg: prepared.bytes.toString('base64') };
    }
    return {
        status: prepared.status,
        reason: prepared.failure.reason,
        disposition: prepared.failure.disposition,
    };
}

function restoreArchivedMedia(
    item: SelectedAnalysisMedia,
    value: unknown,
    fail: () => never,
): PreparedMedia {
    const parsed = archiveMediaSchema.safeParse(value);
    if (!parsed.success) return fail();
    const row = parsed.data;
    if (row.status === 'failure') {
        return {
            status: row.status,
            item,
            failure: {
                selectionId: item.selectionId,
                reason: row.reason,
                disposition: row.disposition,
            },
        };
    }
    const bytes = Buffer.from(row.jpeg, 'base64');
    if (!validJpeg(bytes) || bytes.toString('base64') !== row.jpeg) return fail();
    return { status: row.status, item, bytes };
}

type NormalizedSelection = {
    media: NormalizedAiMediaSelection[];
    bytes: Map<string, Buffer>;
    coverage: AnalysisV2ProfileMediaCoverage;
};

function archiveSelection(selected: readonly SelectedAnalysisMedia[], version: string) {
    const selectionHash = createHash('sha256').update(JSON.stringify(selected.map(item => [
        item.selectionId, archiveMediaUrlAnchor(item.imageUrl), item.role, item.postId ?? null,
        item.postType ?? null, item.mediaIndex ?? null,
    ]))).digest('hex');
    return {
        key: [version, selectionHash],
        members: selected.map((_, index) => [version, selectionHash, index]),
    };
}

function checkMembership(value: unknown, expected: (string | number)[][], fail: () => never) {
    if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, i) => (
        !Array.isArray(entry) || entry.length !== 3 || entry.some((part, j) => part !== expected[i]![j])
    ))) fail();
}

/** Save selected outcomes before any Dev capture branch can skip them. This does not admit an AI call. */
export async function captureDevStandardMediaSelection(
    selected: readonly SelectedAnalysisMedia[],
    normalize: (item: SelectedAnalysisMedia) => Promise<Buffer>,
    version: string,
    restorePinned?: () => Promise<NormalizedSelection>,
): Promise<void> {
    const archive = currentDevStandardArchive();
    if (archive?.mode !== 'capture' || !selected.length) return;
    const selection = archiveSelection(selected, version);
    const marker = await archive.find('ai-image-selection-v1', selection.key);
    if (marker) {
        checkMembership(marker.value, selection.members, archive.fail);
        if (!restorePinned) return;
    }
    const pinned = await restorePinned?.();
    // Create each immutable child as soon as its download or pinned result is ready.
    // Drain outstanding writes before releasing the worker if any child fails.
    const writes = await Promise.allSettled(selected.map(async (item, i) => {
        const identity = selection.members[i]!;
        const prior = await archive.find('ai-image', identity);
        let row: PreparedMedia;
        if (pinned) {
            const bytes = pinned.bytes.get(item.selectionId);
            const failure = pinned.coverage.failures.find(part => part.selectionId === item.selectionId);
            if (Boolean(bytes) === Boolean(failure)) return archive.fail();
            row = bytes ? { status: 'success', item, bytes } : { status: 'failure', item, failure: failure! };
        } else if (prior) {
            restoreArchivedMedia(item, prior.value, archive.fail);
            return;
        } else {
            row = await prepareMedia(item, normalize);
        }
        if (prior) {
            const existing = restoreArchivedMedia(item, prior.value, archive.fail);
            if (row.status === 'success' && existing.status === 'success' && row.bytes.equals(existing.bytes)) return;
            if (row.status === 'failure' && existing.status === 'failure'
                && row.failure.reason === existing.failure.reason && row.failure.disposition === existing.failure.disposition) return;
            return archive.fail();
        }
        await archive.capture('ai-image', identity, archiveMediaValue(row, archive.fail));
    }));
    const failed = writes.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (!marker) await archive.capture('ai-image-selection-v1', selection.key, selection.members);
}

export async function normalizeAnalysisV2MediaSelections(
    selected: readonly SelectedAnalysisMedia[],
    normalizeMedia: (media: SelectedAnalysisMedia) => Promise<Buffer>,
    aiStagePolicyVersion: string = 'ai-stage-policy-v2.6',
): Promise<Readonly<NormalizedSelection>> {
    const archive = currentDevStandardArchive();
    const selection = archive ? archiveSelection(selected, aiStagePolicyVersion) : null;
    if (archive?.mode === 'replay' && selected.length) {
        const marker = await archive.load('ai-image-selection-v1', selection!.key);
        checkMembership(marker, selection!.members, archive.fail);
    }
    const alreadyCaptured = new Set<number>();
    const prepared = await Promise.all(selected.map(async (item, index) => {
        if (archive?.mode === 'replay') {
            const value = await archive.load('ai-image', selection!.members[index]!);
            // Missing or invalid archive records must never become a tolerated
            // CDN coverage gap. Actual recorded failures retain their status.
            return restoreArchivedMedia(item, value, () => archive.fail());
        }
        if (archive?.mode === 'capture') {
            const prior = await archive.find('ai-image', selection!.members[index]!);
            if (prior) {
                alreadyCaptured.add(index);
                return restoreArchivedMedia(item, prior.value, () => archive.fail());
            }
        }
        return prepareMedia(item, normalizeMedia);
    }));
    const successful = prepared.filter(item => item.status === 'success');
    const failures = prepared.flatMap(item => (
        item.status === 'failure' ? [item.failure] : []
    ));
    if (
        !supportsPartialMediaCoverage(aiStagePolicyVersion)
        && failures.some(failure => failure.disposition === 'transient')
    ) {
        const failureReasons = failures.reduce<Record<string, number>>((counts, failure) => {
            counts[failure.reason] = (counts[failure.reason] ?? 0) + 1;
            return counts;
        }, {});
        console.warn('Analysis V2 media preparation has transient failures', {
            selectedCount: selected.length,
            failureReasons,
        });
        throw new AnalysisV2TransientMediaPreparationError();
    }
    if (archive?.mode === 'capture') {
        await Promise.all(prepared.map((row, index) => {
            if (alreadyCaptured.has(index)) return undefined;
            const value = archiveMediaValue(row, () => archive.fail());
            return archive.capture('ai-image', selection!.members[index]!, value);
        }));
        await archive.capture(
            'ai-image-selection-v1',
            selection!.key,
            selection!.members,
        );
    }
    const media: NormalizedAiMediaSelection[] = successful.map(({ item, bytes }) => ({
        selectionId: item.selectionId,
        kind: item.role === 'profile' ? 'profile' : 'feed',
        normalizedJpegBase64: bytes.toString('base64'),
        ...(item.postId ? { postId: item.postId } : {}),
    }));
    return {
        media,
        bytes: new Map(successful.map(item => [item.item.selectionId, item.bytes])),
        coverage: Object.freeze({
            selectedCount: selected.length,
            normalizedCount: successful.length,
            failures: Object.freeze(failures),
        }),
    };
}
