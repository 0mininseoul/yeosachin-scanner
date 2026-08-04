import { createHash } from 'node:crypto';
import {
    ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES,
    createGoogleCloudPrivateMediaObjectClient,
    deserializeAnalysisV2MediaBundle,
    getAnalysisV2MediaArtifactBucket,
    serializeAnalysisV2MediaBundle,
    type AnalysisV2LoadedMediaBundleItem,
    type AnalysisV2NormalizedMediaBundleItem,
    type AnalysisV2PrivateRetainedMediaObjectClient,
} from './v2-media-artifact-store';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ARCHIVE_ID_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;

export type AnalysisV2SourceMediaArchiveStage =
    | 'triage'
    | 'feature_remainder'
    | 'partner_contact_remainder'
    | 'partner_contact_sheet';
const ARCHIVE_STAGES = new Set<AnalysisV2SourceMediaArchiveStage>([
    'triage',
    'feature_remainder',
    'partner_contact_remainder',
    'partner_contact_sheet',
]);

export interface AnalysisV2SourceMediaArchiveStore {
    persistBundle(input: {
        requestId: string;
        archiveId: string;
        media: readonly AnalysisV2NormalizedMediaBundleItem[];
    }): Promise<void>;
    /** Read-only maintenance/replay hook; null means a pre-archive legacy source. */
    loadBundle(input: {
        requestId: string;
        archiveId: string;
        expectedSelectionIds: readonly string[];
    }): Promise<AnalysisV2LoadedMediaBundleItem[] | null>;
}

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function requestArchiveKey(requestId: string): string {
    const normalized = requestId.trim().toLowerCase();
    if (!UUID_PATTERN.test(normalized)) {
        throw new Error('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_VALIDATION_ERROR: invalid request.');
    }
    return sha256(`analysis-v2-source-media-request:v1\n${normalized}`);
}

function requiredArchiveId(value: string): string {
    const normalized = value.trim();
    if (!ARCHIVE_ID_PATTERN.test(normalized)) {
        throw new Error('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_VALIDATION_ERROR: invalid archive id.');
    }
    return normalized;
}

export function analysisV2SourceMediaArchiveId(input: {
    candidateId: string;
    stage: AnalysisV2SourceMediaArchiveStage;
}): string {
    const candidateId = input.candidateId.trim();
    if (!candidateId || candidateId.length > 160) {
        throw new Error('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_VALIDATION_ERROR: invalid candidate.');
    }
    if (!ARCHIVE_STAGES.has(input.stage)) {
        throw new Error(
            'ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_VALIDATION_ERROR: invalid archive stage.'
        );
    }
    return `bundle:${input.stage}:${sha256(
        `analysis-v2-source-media-candidate:v1\n${candidateId}`
    )}`;
}

export function analysisV2SourceMediaArchiveObjectName(input: {
    requestId: string;
    archiveId: string;
}): string {
    const requestKey = requestArchiveKey(input.requestId);
    const archiveKey = sha256(
        `analysis-v2-source-media-archive:v1\n${requiredArchiveId(input.archiveId)}`
    );
    if (!HASH_PATTERN.test(requestKey) || !HASH_PATTERN.test(archiveKey)) {
        throw new Error('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_VALIDATION_ERROR: invalid key.');
    }
    return `analysis-v2-retained/${requestKey}/${archiveKey}.bin`;
}

export function createAnalysisV2SourceMediaArchiveStore(input: {
    objects: AnalysisV2PrivateRetainedMediaObjectClient;
}): AnalysisV2SourceMediaArchiveStore {
    return {
        async persistBundle(value) {
            const objectName = analysisV2SourceMediaArchiveObjectName(value);
            const bytes = serializeAnalysisV2MediaBundle(value.media);
            await input.objects.createRetained({
                objectName,
                bytes,
                contentSha256: sha256(bytes),
                contentType: 'application/octet-stream',
            });
        },

        async loadBundle(value) {
            const objectName = analysisV2SourceMediaArchiveObjectName(value);
            const bytes = await input.objects.readRetained({
                objectName,
                maximumBytes: ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES,
            });
            if (!bytes) return null;
            return deserializeAnalysisV2MediaBundle(bytes, value.expectedSelectionIds);
        },
    };
}

export function createConfiguredAnalysisV2SourceMediaArchiveStore(
    env: Readonly<Record<string, string | undefined>> = process.env
): AnalysisV2SourceMediaArchiveStore {
    const bucketName = getAnalysisV2MediaArtifactBucket(env);
    if (!bucketName) {
        throw new Error('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_CONFIG_ERROR: bucket is required.');
    }
    return createAnalysisV2SourceMediaArchiveStore({
        objects: createGoogleCloudPrivateMediaObjectClient({ bucketName }),
    });
}
