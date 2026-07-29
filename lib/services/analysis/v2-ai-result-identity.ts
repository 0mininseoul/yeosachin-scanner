import { createHash } from 'node:crypto';
import { z } from 'zod';

const MAX_HASH_MATERIAL_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const STAGES = [
    'genderTriage', 'genderResolution', 'featureAnalysis',
    'highRiskNarrative', 'privateAccountName', 'partnerSafety',
] as const;
type Stage = typeof STAGES[number];
const PREFIX: Readonly<Record<Stage, string>> = {
    genderTriage: 'gender-triage',
    genderResolution: 'gender-resolution',
    featureAnalysis: 'feature-analysis',
    highRiskNarrative: 'high-risk-narrative',
    privateAccountName: 'private-account-name',
    partnerSafety: 'partner-safety',
};
const GLOBAL = new Set<Stage>(['genderTriage', 'featureAnalysis']);
const materialSchema = z.object({
    stage: z.enum(STAGES),
    modelName: z.string().regex(MODEL_PATTERN),
    thinkingLevel: z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']).nullable(),
    mediaResolution: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable(),
    promptVersion: z.string().regex(VERSION_PATTERN),
    schemaVersion: z.number().int().min(1).max(9_999),
    maxOutputTokens: z.number().int().min(1).max(65_536),
    inputHash: z.string().regex(SHA256_PATTERN),
    mediaSnapshotHash: z.string().regex(SHA256_PATTERN),
    cacheScope: z.enum(['request', 'global_ttl']),
}).strict().superRefine((value, context) => {
    if (value.cacheScope === 'global_ttl' && !GLOBAL.has(value.stage)) {
        context.addIssue({
            code: 'custom',
            path: ['cacheScope'],
            message: 'Invalid global cache stage.',
        });
    }
});

export type AnalysisV2AiResultIdentityMaterial = z.infer<
    typeof materialSchema
>;
export interface AnalysisV2AiResultIdentity
    extends AnalysisV2AiResultIdentityMaterial {
    cacheKey: string;
    operationKey: string;
}
export interface AnalysisV2AiIdentityMediaPart {
    selectionId: string;
    kind: 'profile' | 'feed' | 'contact_sheet';
    normalizedJpegBase64: string;
    postId?: string | null;
}
export interface AnalysisV2AiPreparedResult<T> {
    result: T | null;
    source: 'request' | 'global_cache' | null;
    startingAttempt: number;
}

function sha256(domain: string, material: string): string {
    if (
        !material.length
        || Buffer.byteLength(material, 'utf8') > MAX_HASH_MATERIAL_BYTES
    ) {
        throw new Error(
            'ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid hash material.',
        );
    }
    return createHash('sha256')
        .update(domain)
        .update('\0')
        .update(material)
        .digest('hex');
}
export const createAnalysisV2AiResultInputHash = (value: string) =>
    sha256('analysis-v2-ai-result-input:v1', value);
export const createAnalysisV2AiMediaSnapshotHash = (value: string) =>
    sha256('analysis-v2-ai-media-snapshot:v1', value);
export function createAnalysisV2AiMediaSnapshotHashFromParts(
    media: readonly AnalysisV2AiIdentityMediaPart[],
): string {
    const manifest = media.map((item, index) => {
        if (
            typeof item.selectionId !== 'string'
            || item.selectionId.length < 1
            || item.selectionId.length > 240
            || typeof item.normalizedJpegBase64 !== 'string'
            || item.normalizedJpegBase64.length < 4
        ) {
            throw new Error(
                'ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid identity media.',
            );
        }
        return {
            index,
            selectionId: item.selectionId,
            kind: item.kind,
            postId: item.postId ?? null,
            contentHash: createHash('sha256')
                .update('analysis-v2-ai-normalized-media-content:v1\0')
                .update(item.normalizedJpegBase64)
                .digest('hex'),
        };
    });
    return createAnalysisV2AiMediaSnapshotHash(JSON.stringify(manifest));
}
export function createAnalysisV2AiResultIdentity(
    raw: AnalysisV2AiResultIdentityMaterial,
): AnalysisV2AiResultIdentity {
    const parsed = materialSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(
            'ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid result identity.',
        );
    }
    const value = parsed.data;
    const cacheKey = createHash('sha256').update([
        'analysis-v2-ai-result-cache:v1', value.stage, value.modelName,
        value.thinkingLevel ?? '-', value.mediaResolution ?? '-',
        value.promptVersion, String(value.schemaVersion),
        String(value.maxOutputTokens), value.inputHash, value.mediaSnapshotHash,
    ].join('\n')).digest('hex');
    return {
        ...value,
        cacheKey,
        operationKey: `${PREFIX[value.stage]}:${cacheKey}`,
    };
}
export function analysisV2AiResultIdentitiesEqual(
    left: AnalysisV2AiResultIdentity,
    right: AnalysisV2AiResultIdentity,
): boolean {
    return left.operationKey === right.operationKey
        && left.cacheKey === right.cacheKey
        && left.stage === right.stage
        && left.modelName === right.modelName
        && left.thinkingLevel === right.thinkingLevel
        && left.mediaResolution === right.mediaResolution
        && left.promptVersion === right.promptVersion
        && left.schemaVersion === right.schemaVersion
        && left.maxOutputTokens === right.maxOutputTokens
        && left.inputHash === right.inputHash
        && left.mediaSnapshotHash === right.mediaSnapshotHash
        && left.cacheScope === right.cacheScope;
}
