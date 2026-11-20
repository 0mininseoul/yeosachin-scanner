import type { GenerateContentParameters } from '@google/genai';
import { estimateVertexAiPreDispatchCost } from '@/lib/services/ai/vertex-ai-cost-policy';

const VERTEX_MODELS = new Set(['gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.7-flash']);
const MAX_INPUT_TOKENS = 1_048_576;
const MAX_OUTPUT_TOKENS = 65_536;
// The largest supported analysis slice is one profile image plus ten feed images.
const MAX_IMAGE_PARTS = 11;
const SUPPORTED_MEDIA_RESOLUTIONS = new Set([
    'MEDIA_RESOLUTION_UNSPECIFIED',
    'MEDIA_RESOLUTION_LOW',
    'MEDIA_RESOLUTION_MEDIUM',
    'MEDIA_RESOLUTION_HIGH',
]);
// Use the maximum of the supported global image resolutions, even for LOW and MEDIUM.
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/image-understanding
const INPUT_TOKENS_PER_IMAGE = 1_120;
const REQUEST_OVERHEAD_TOKENS = 2_048;

function hasOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).every(key => allowed.includes(key));
}

function serializedTokenBound(value: unknown): number | null {
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) return null;
        // UTF-8 bytes are a conservative proxy for text tokens, including JSON escapes.
        return Math.max(Buffer.byteLength(serialized), Buffer.byteLength(serialized.normalize('NFKD')));
    } catch {
        return null;
    }
}

/** Prices only the single-message JPEG and JSON request emitted by the Dev SDK path. */
export function estimateDevLiveVertexReservation(request: GenerateContentParameters, location: string) {
    if (
        location !== 'global' || !VERTEX_MODELS.has(request.model)
        || !hasOnlyKeys(request, ['model', 'contents', 'config'])
        || !Array.isArray(request.contents) || request.contents.length !== 1
    ) return null;

    const { config } = request;
    if (
        !hasOnlyKeys(config, [
            'responseMimeType', 'responseJsonSchema', 'httpOptions', 'candidateCount',
            'abortSignal', 'maxOutputTokens', 'temperature', 'mediaResolution', 'thinkingConfig',
        ])
        || config.responseMimeType !== 'application/json' || config.candidateCount !== 1
        || !hasOnlyKeys(config.httpOptions, ['timeout', 'retryOptions'])
        || !hasOnlyKeys(config.httpOptions.retryOptions, ['attempts'])
        || config.httpOptions.retryOptions.attempts !== 1
        || (config.thinkingConfig !== undefined && !hasOnlyKeys(config.thinkingConfig, ['thinkingLevel']))
        || (config.mediaResolution !== undefined && (
            typeof config.mediaResolution !== 'string' || !SUPPORTED_MEDIA_RESOLUTIONS.has(config.mediaResolution)
        ))
        || typeof config.maxOutputTokens !== 'number' || !Number.isSafeInteger(config.maxOutputTokens)
        || config.maxOutputTokens < 1 || config.maxOutputTokens > MAX_OUTPUT_TOKENS
    ) return null;

    const [content]: unknown[] = request.contents;
    if (!hasOnlyKeys(content, ['role', 'parts']) || content.role !== 'user' || !Array.isArray(content.parts)) {
        return null;
    }
    const [textPart, ...imageParts]: unknown[] = content.parts;
    if (!hasOnlyKeys(textPart, ['text']) || typeof textPart.text !== 'string') return null;
    if (imageParts.length > MAX_IMAGE_PARTS || !imageParts.every(part => (
        hasOnlyKeys(part, ['inlineData']) && hasOnlyKeys(part.inlineData, ['mimeType', 'data'])
        && part.inlineData.mimeType === 'image/jpeg'
        && typeof part.inlineData.data === 'string' && part.inlineData.data.length > 0
    ))) return null;

    // The provider counts the structured response schema toward the input limit.
    // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output
    if (!config.responseJsonSchema || typeof config.responseJsonSchema !== 'object'
        || Array.isArray(config.responseJsonSchema)) return null;
    const promptBound = serializedTokenBound(textPart.text);
    const schemaBound = serializedTokenBound(config.responseJsonSchema);
    if (promptBound === null || schemaBound === null) return null;
    const inputTokens = promptBound + schemaBound
        + imageParts.length * INPUT_TOKENS_PER_IMAGE + REQUEST_OVERHEAD_TOKENS;
    if (inputTokens > MAX_INPUT_TOKENS) return null;
    return estimateVertexAiPreDispatchCost({
        modelName: request.model, location, inputTokens, maxOutputTokens: config.maxOutputTokens,
    });
}
