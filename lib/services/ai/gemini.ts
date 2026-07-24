import {
    GoogleGenAI,
    MediaResolution,
    ThinkingLevel,
    type GenerateContentConfig,
    type Part,
} from '@google/genai';
import { toJSONSchema, type ZodType } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    estimateGeminiRequestCost,
    isVertexAICostOptimized,
    resolveVertexAIModel,
} from './gemini-cost';
import {
    getAnalysisImagePolicy,
    imageUrlToNormalizedBase64,
} from './image-preprocessing';
import { parseGeminiJsonResponse } from './gemini-response';
import { prepareGoogleApplicationCredentials } from '@/lib/services/google/credentials';
import {
    AI_AMBIGUOUS_GENERATION_ERROR_PREFIX,
    AI_GENERATION_RESPONSE_REJECTED_ERROR_PREFIX,
    AI_RATE_LIMIT_ERROR_PREFIX,
    classifyGeminiGenerationError,
} from './gemini-generation-policy';
import {
    AI_SHARED_CONCURRENCY_LIMIT,
    AI_GEMINI_SDK_TIMEOUT_MS,
    getAiStagePolicy,
    isAiStageName,
    type AiMediaResolution,
    type AiStageName,
    type AiThinkingLevel,
} from './stage-policy';

const GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'global';

let genAI: GoogleGenAI | null = null;
let extendedTelemetrySupported: boolean | null = null;

class AsyncSemaphore {
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve();
        }

        return new Promise<void>(resolve => this.queue.push(resolve));
    }

    private release(): void {
        const next = this.queue.shift();
        if (next) {
            next();
            return;
        }

        this.active--;
    }
}

interface GeminiGenerationLimiterState {
    shared: AsyncSemaphore;
    stages: Map<AiStageName, AsyncSemaphore>;
}

const processScope = globalThis as typeof globalThis & {
    __AI_BARAM_GEMINI_GENERATION_LIMITER_V1__?: GeminiGenerationLimiterState;
};
const generationLimiterState = processScope.__AI_BARAM_GEMINI_GENERATION_LIMITER_V1__ ?? {
    shared: new AsyncSemaphore(AI_SHARED_CONCURRENCY_LIMIT),
    stages: new Map<AiStageName, AsyncSemaphore>(),
};
processScope.__AI_BARAM_GEMINI_GENERATION_LIMITER_V1__ = generationLimiterState;

function getStageGenerationSemaphore(stage: AiStageName): AsyncSemaphore {
    const existing = generationLimiterState.stages.get(stage);
    if (existing) return existing;

    const semaphore = new AsyncSemaphore(getAiStagePolicy(stage).concurrency);
    generationLimiterState.stages.set(stage, semaphore);
    return semaphore;
}

async function runWithGenerationSlot<T>(
    stage: AiStageName | null,
    task: () => Promise<T>
): Promise<T> {
    if (!stage) {
        return generationLimiterState.shared.run(task);
    }

    // Acquire the narrower stage slot first so queued stage work cannot occupy
    // otherwise-available shared capacity.
    return getStageGenerationSemaphore(stage).run(() => generationLimiterState.shared.run(task));
}

function getGenAIClient(): GoogleGenAI {
    if (genAI) {
        return genAI;
    }

    prepareGoogleApplicationCredentials();

    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) {
        throw new Error('GOOGLE_CLOUD_PROJECT is required to use Gemini through Vertex AI');
    }

    genAI = new GoogleGenAI({
        vertexai: true,
        project,
        location: GOOGLE_CLOUD_LOCATION,
    });

    return genAI;
}

// 재시도 설정
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000, // 1초
    maxDelay: 10000, // 최대 10초
};

const AI_ADMISSION_SIGNAL_CODES = new Set([
    'ANALYSIS_V2_AI_CAPACITY_PENDING',
    'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
    'ANALYSIS_V2_AI_QUARANTINE_ACTIVE',
]);

// 토큰 사용량 타입
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    thinkingTokens?: number;
}

// 분석 결과 + 토큰 사용량
export interface AnalysisResult<T> {
    data: T;
    tokenUsage: TokenUsage;
}

export type GeminiUsageMetadataStatus = 'complete' | 'missing' | 'malformed';
export type GeminiAttemptDisposition =
    | 'success'
    | 'rate_limited'
    | 'ambiguous'
    | 'rejected'
    | 'response_rejected';

export interface GeminiRequestTelemetry {
    tokenUsage: TokenUsage | null;
    usageComplete: boolean;
    usageMetadataStatus: GeminiUsageMetadataStatus;
    modelName: string;
    location: string;
    stage: AiStageName | null;
    thinkingLevel: AiThinkingLevel | null;
    mediaCount: number;
    mediaResolution: AiMediaResolution | null;
    promptVersion: string | null;
    schemaVersion: number | null;
    maxOutputTokens: number | null;
    latencyMs: number;
    estimatedCostUsd: number | null;
}

export interface GeminiAttemptTelemetry extends GeminiRequestTelemetry {
    attempt: number;
    retryCount: number;
    disposition: GeminiAttemptDisposition;
    finishReason: string | null;
}

export interface GeminiAttemptStartTelemetry {
    requestId: string;
    modelName: string;
    location: string;
    stage: AiStageName;
    thinkingLevel: AiThinkingLevel | null;
    mediaCount: number;
    mediaResolution: AiMediaResolution | null;
    promptVersion: string;
    schemaVersion: number;
    maxOutputTokens: number;
    attempt: number;
    retryCount: number;
}

export interface AnalyzeWithGeminiOptions<T> {
    schema: ZodType<T>;
    analysisType?: string;
    requestId?: string;
    skipTokenLog?: boolean;
    stage?: AiStageName;
    model?: string;
    thinkingLevel?: AiThinkingLevel;
    mediaResolution?: AiMediaResolution;
    maxOutputTokens?: number;
    /** Resume only after a durably terminalized explicit 429. Attempts are globally bounded at 4. */
    startingAttempt?: number;
    onTelemetry?: (telemetry: GeminiRequestTelemetry) => void | Promise<void>;
    /** Reserve a durable, PII-free generation intent before the SDK request starts. */
    onBeforeAttempt?: (telemetry: GeminiAttemptStartTelemetry) => void | Promise<void>;
    /** The V2 caller must persist this PII-free event when it is used as the stage audit sink. */
    onAttemptTelemetry?: (
        telemetry: GeminiAttemptTelemetry,
        parsedResult?: T
    ) => void | Promise<void>;
}

interface TokenLogMetadata {
    latencyMs?: number;
    location?: string;
    estimatedCostUsd?: number | null;
}

/**
 * Exponential backoff delay 계산
 */
function getRetryDelay(attempt: number): number {
    const delay = RETRY_CONFIG.baseDelay * Math.pow(2, attempt);
    return Math.min(delay, RETRY_CONFIG.maxDelay);
}

/**
 * 지연 함수
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class RetryableGeminiRateLimitError extends Error {
    constructor() {
        super(`${AI_RATE_LIMIT_ERROR_PREFIX} Gemini rejected the request due to rate limiting.`);
        this.name = 'RetryableGeminiRateLimitError';
    }
}

function sanitizeGenerationError(error: unknown): Error {
    const disposition = classifyGeminiGenerationError(error);
    if (disposition === 'rate_limited') {
        return new RetryableGeminiRateLimitError();
    }
    if (disposition === 'ambiguous') {
        return new Error(
            `${AI_AMBIGUOUS_GENERATION_ERROR_PREFIX} Gemini generation status is unknown; the request was not retried.`
        );
    }
    return new Error('AI_GENERATION_REQUEST_ERROR: Gemini rejected the generation request.');
}

const SUPPORTED_RESPONSE_SCHEMA_KEYS = new Set([
    '$id',
    '$defs',
    '$ref',
    '$anchor',
    'type',
    'format',
    'title',
    'description',
    'enum',
    'items',
    'prefixItems',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
    'anyOf',
    'oneOf',
    'properties',
    'additionalProperties',
    'required',
    'propertyOrdering',
]);

function sanitizeResponseJsonSchema(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sanitizeResponseJsonSchema);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    const source = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(source)) {
        if (key === 'const') {
            if (!('enum' in source)) sanitized.enum = [child];
            continue;
        }
        if (!SUPPORTED_RESPONSE_SCHEMA_KEYS.has(key)) continue;

        if ((key === 'properties' || key === '$defs') && child && typeof child === 'object') {
            sanitized[key] = Object.fromEntries(
                Object.entries(child as Record<string, unknown>)
                    .map(([name, schema]) => [name, sanitizeResponseJsonSchema(schema)])
            );
            continue;
        }

        sanitized[key] = sanitizeResponseJsonSchema(child);
    }

    return sanitized;
}

/** Convert a strict runtime Zod schema to the JSON Schema subset accepted by Vertex AI. */
export function zodToGeminiResponseJsonSchema<T>(schema: ZodType<T>): Record<string, unknown> {
    const generated = toJSONSchema(schema, {
        target: 'draft-2020-12',
        // The model response is the wire input that Zod parses and transforms.
        io: 'input',
        cycles: 'throw',
        reused: 'inline',
        unrepresentable: 'throw',
    });
    const sanitized = sanitizeResponseJsonSchema(generated);
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
        throw new Error('Gemini response schema must map to a JSON Schema object');
    }
    return sanitized as Record<string, unknown>;
}

const THINKING_LEVEL_CONFIG: Record<AiThinkingLevel, ThinkingLevel> = {
    MINIMAL: ThinkingLevel.MINIMAL,
    LOW: ThinkingLevel.LOW,
    MEDIUM: ThinkingLevel.MEDIUM,
    HIGH: ThinkingLevel.HIGH,
};

const MEDIA_RESOLUTION_CONFIG: Record<AiMediaResolution, MediaResolution> = {
    LOW: MediaResolution.MEDIA_RESOLUTION_LOW,
    MEDIUM: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    HIGH: MediaResolution.MEDIA_RESOLUTION_HIGH,
};

function validateExplicitModel(model: string | undefined): string | undefined {
    if (model === undefined) return undefined;
    const normalized = model.trim();
    if (!normalized || normalized.length > 256 || /\s/.test(normalized)) {
        throw new Error('Gemini model must be a non-empty model identifier');
    }
    return normalized;
}

function validateThinkingLevel(level: AiThinkingLevel | undefined): void {
    if (
        level !== undefined
        && !Object.prototype.hasOwnProperty.call(THINKING_LEVEL_CONFIG, level)
    ) {
        throw new Error('Gemini thinkingLevel must be MINIMAL, LOW, MEDIUM, or HIGH');
    }
}

function validateMediaResolution(resolution: AiMediaResolution | undefined): void {
    if (
        resolution !== undefined
        && !Object.prototype.hasOwnProperty.call(MEDIA_RESOLUTION_CONFIG, resolution)
    ) {
        throw new Error('Gemini mediaResolution must be LOW, MEDIUM, or HIGH');
    }
}

interface StrictUsageMetadata {
    tokenUsage: TokenUsage | null;
    status: GeminiUsageMetadataStatus;
}

function readNonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0
        ? value
        : null;
}

function extractStrictUsageMetadata(value: unknown): StrictUsageMetadata {
    if (value === undefined || value === null) {
        return { tokenUsage: null, status: 'missing' };
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        return { tokenUsage: null, status: 'malformed' };
    }

    const metadata = value as Record<string, unknown>;
    const promptTokens = readNonNegativeInteger(metadata.promptTokenCount);
    const completionTokens = readNonNegativeInteger(metadata.candidatesTokenCount);
    const totalTokens = readNonNegativeInteger(metadata.totalTokenCount);
    const reportedThinkingTokens = metadata.thoughtsTokenCount === undefined
        ? null
        : readNonNegativeInteger(metadata.thoughtsTokenCount);

    if (
        promptTokens === null
        || completionTokens === null
        || totalTokens === null
        || (metadata.thoughtsTokenCount !== undefined && reportedThinkingTokens === null)
    ) {
        return { tokenUsage: null, status: 'malformed' };
    }
    const inferredThinkingTokens = totalTokens - promptTokens - completionTokens;
    if (
        inferredThinkingTokens < 0
        || (
            reportedThinkingTokens !== null
            && reportedThinkingTokens !== inferredThinkingTokens
        )
    ) {
        return { tokenUsage: null, status: 'malformed' };
    }

    return {
        tokenUsage: {
            promptTokens,
            completionTokens,
            totalTokens,
            thinkingTokens: reportedThinkingTokens ?? inferredThinkingTokens,
        },
        status: 'complete',
    };
}

interface GeminiResponseCandidateShape {
    finishReason?: unknown;
    content?: { parts?: unknown };
}

interface GeminiResponseShape {
    candidates?: unknown;
}

function readSingleCandidateFinishReason(response: GeminiResponseShape): string | null {
    if (!Array.isArray(response.candidates) || response.candidates.length !== 1) return null;
    const value = response.candidates[0];
    if (!value || typeof value !== 'object') return null;
    const candidate = value as GeminiResponseCandidateShape;
    return typeof candidate.finishReason === 'string' ? candidate.finishReason : null;
}

function extractSuccessfulCandidateText(response: GeminiResponseShape): string {
    if (!Array.isArray(response.candidates) || response.candidates.length !== 1) {
        throw new Error('Gemini response did not include exactly one candidate');
    }

    const value = response.candidates[0];
    if (!value || typeof value !== 'object') {
        throw new Error('Gemini response did not include exactly one usable candidate');
    }
    const candidate = value as GeminiResponseCandidateShape;
    if (candidate.finishReason !== 'STOP') {
        throw new Error('Gemini response did not finish successfully');
    }

    const parts = candidate.content?.parts;
    if (!Array.isArray(parts)) {
        throw new Error('Gemini response did not include text');
    }
    const text = parts
        .filter(part => part && typeof part === 'object')
        .filter(part => (part as { thought?: unknown }).thought !== true)
        .map(part => (part as { text?: unknown }).text)
        .filter((part): part is string => typeof part === 'string')
        .join('')
        .trim();

    if (!text) {
        throw new Error('Gemini response did not include text');
    }
    return text;
}

async function emitAttemptTelemetry<T>(
    telemetry: GeminiAttemptTelemetry,
    hook: AnalyzeWithGeminiOptions<T>['onAttemptTelemetry'],
    parsedResult?: T
): Promise<void> {
    console.log('Gemini SDK attempt telemetry:', telemetry);
    if (!hook) return;

    try {
        if (telemetry.disposition === 'success') {
            await hook(telemetry, parsedResult);
        } else {
            await hook(telemetry);
        }
    } catch (error) {
        // A fenced result means the attempt telemetry committed, but the stale worker was
        // intentionally prevented from mutating request/cache state. Preserve that outcome so
        // callers do not misclassify it as an ambiguous persistence failure.
        if (error instanceof Error && error.name === 'AnalysisV2AiResultFenceError') {
            throw error;
        }
        throw new Error(
            'AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR: Gemini attempt result was not durably stored.'
        );
    }
}

const REQUEST_UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 토큰 사용량을 DB에 저장
 */
export async function logTokenUsage(
    tokenUsage: TokenUsage,
    analysisType: string,
    requestId?: string,
    cachedHit: boolean = false,
    modelName: string = resolveVertexAIModel(),
    metadata: TokenLogMetadata = {}
): Promise<void> {
    const location = metadata.location ?? GOOGLE_CLOUD_LOCATION;
    const estimatedCostUsd = metadata.estimatedCostUsd
        ?? estimateGeminiRequestCost(tokenUsage, modelName, location)?.totalCostUsd
        ?? null;
    const baseRow = {
        request_id: requestId || null,
        prompt_tokens: tokenUsage.promptTokens,
        completion_tokens: tokenUsage.completionTokens,
        total_tokens: tokenUsage.totalTokens,
        analysis_type: analysisType,
        model_name: modelName,
        cached_hit: cachedHit,
    };

    try {
        if (extendedTelemetrySupported !== false) {
            const { error } = await supabaseAdmin.from('gemini_token_usage').insert({
                ...baseRow,
                thinking_tokens: tokenUsage.thinkingTokens ?? 0,
                latency_ms: metadata.latencyMs ?? null,
                estimated_cost_usd: estimatedCostUsd,
                model_location: location,
            });

            if (!error) {
                extendedTelemetrySupported = true;
                return;
            }

            const errorText = JSON.stringify(error).toLowerCase();
            const isMissingExtendedColumn = [
                'thinking_tokens',
                'latency_ms',
                'estimated_cost_usd',
                'model_location',
            ].some(column => errorText.includes(column))
                && (errorText.includes('schema cache')
                    || errorText.includes('column')
                    || errorText.includes('does not exist'));

            if (!isMissingExtendedColumn) {
                throw error;
            }

            extendedTelemetrySupported = false;
            console.warn('Extended Gemini telemetry columns are unavailable; using base token logging');
        }

        const { error } = await supabaseAdmin.from('gemini_token_usage').insert(baseRow);
        if (error) {
            throw error;
        }
    } catch (error) {
        // 토큰 로깅 실패는 분석 실패로 이어지지 않도록
        console.warn('Failed to log token usage:', error);
    }
}

/**
 * Gemini AI를 사용하여 프롬프트 분석 수행 (재시도 로직 + 토큰 추적 포함)
 * @param prompt - 분석 프롬프트
 * @param images - base64 인코딩된 이미지 배열 (선택)
 * @param options - 추가 옵션 (분석 타입, requestId 등)
 * @returns 파싱된 JSON 응답 + 토큰 사용량
 */
export async function analyzeWithGemini<T>(
    prompt: string,
    images: string[] | undefined,
    options: AnalyzeWithGeminiOptions<T>
): Promise<T> {
    const {
        analysisType = 'unknown',
        requestId,
        skipTokenLog = false,
        stage,
        model,
        thinkingLevel,
        mediaResolution,
        maxOutputTokens,
        startingAttempt = 1,
        onTelemetry,
        onBeforeAttempt,
        onAttemptTelemetry,
        schema,
    } = options;
    if (stage !== undefined && !isAiStageName(stage)) {
        throw new Error('Gemini stage is not recognized');
    }
    if (
        maxOutputTokens !== undefined
        && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65_536)
    ) {
        throw new Error('Gemini maxOutputTokens must be an integer from 1 to 65536');
    }
    if (!Number.isSafeInteger(startingAttempt) || startingAttempt < 1 || startingAttempt > 4) {
        throw new Error('Gemini startingAttempt must be an integer from 1 to 4');
    }
    if (!stage && startingAttempt !== 1) {
        throw new Error('Gemini attempt resumption is available only for durable stage calls');
    }
    const explicitModel = validateExplicitModel(model);
    validateThinkingLevel(thinkingLevel);
    validateMediaResolution(mediaResolution);
    if (stage && skipTokenLog) {
        throw new Error('Gemini stage calls cannot skip durable token logging');
    }
    if (
        stage
        && (
            !requestId
            || !REQUEST_UUID_PATTERN.test(requestId)
            || typeof onBeforeAttempt !== 'function'
            || typeof onAttemptTelemetry !== 'function'
        )
    ) {
        throw new Error(
            'Gemini stage calls require a valid request UUID and durable attempt callbacks'
        );
    }

    const costOptimized = isVertexAICostOptimized();
    const stagePolicy = stage ? getAiStagePolicy(stage) : null;
    const modelName = explicitModel
        ?? stagePolicy?.model
        ?? resolveVertexAIModel(process.env.VERTEX_AI_MODEL, costOptimized);
    const resolvedThinkingLevel = thinkingLevel
        ?? stagePolicy?.thinkingLevel
        ?? (costOptimized && modelName.startsWith('gemini-3')
            ? 'MINIMAL'
            : null);
    const resolvedMediaResolution = mediaResolution
        ?? stagePolicy?.mediaResolution
        ?? (costOptimized ? 'LOW' : null);
    const resolvedMaxOutputTokens = maxOutputTokens
        ?? stagePolicy?.maxOutputTokens
        ?? (costOptimized ? 1_024 : undefined);
    const imagePolicy = getAnalysisImagePolicy(costOptimized);
    const maxImages = stagePolicy
        ? stagePolicy.profileImageLimit + stagePolicy.feedImageLimit
        : imagePolicy.maxImages;
    const selectedImages = images?.slice(0, maxImages) ?? [];
    const responseJsonSchema = zodToGeminiResponseJsonSchema(schema);
    const analysisStartedAt = performance.now();

    console.log('Gemini analysis started:', {
        stage: stage ?? null,
        mediaCount: selectedImages.length,
    });

    let lastError: Error | null = null;

    for (
        let attemptNumber = startingAttempt;
        attemptNumber <= RETRY_CONFIG.maxRetries + 1;
        attemptNumber++
    ) {
        try {
            if (attemptNumber > startingAttempt) {
                const delay = getRetryDelay(attemptNumber - 2);
                console.log(
                    `Retry attempt ${attemptNumber - 1}/${RETRY_CONFIG.maxRetries} after ${delay}ms`
                );
                await sleep(delay);
            }

            const client = getGenAIClient();
            let attemptStartedAt = performance.now();

            const parts: Part[] = [{ text: prompt }];

            // 이미지가 있으면 추가
            if (selectedImages.length > 0) {
                for (const image of selectedImages) {
                    parts.push({
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: image,
                        },
                    });
                }
            }

            let response;
            try {
                const config: GenerateContentConfig = {
                    responseMimeType: 'application/json',
                    responseJsonSchema,
                    httpOptions: {
                        timeout: AI_GEMINI_SDK_TIMEOUT_MS,
                    },
                    ...(resolvedMaxOutputTokens !== undefined
                        ? { maxOutputTokens: resolvedMaxOutputTokens }
                        : {}),
                    ...(resolvedMediaResolution
                        ? { mediaResolution: MEDIA_RESOLUTION_CONFIG[resolvedMediaResolution] }
                        : {}),
                    ...(resolvedThinkingLevel
                        ? {
                            thinkingConfig: {
                                thinkingLevel: THINKING_LEVEL_CONFIG[resolvedThinkingLevel],
                            },
                        }
                        : {}),
                };
                response = await runWithGenerationSlot(stage ?? null, async () => {
                    attemptStartedAt = performance.now();
                    if (stage && requestId && stagePolicy && onBeforeAttempt) {
                        try {
                            await onBeforeAttempt({
                                requestId,
                                modelName,
                                location: GOOGLE_CLOUD_LOCATION,
                                stage,
                                thinkingLevel: resolvedThinkingLevel,
                                mediaCount: selectedImages.length,
                                mediaResolution: resolvedMediaResolution,
                                promptVersion: stagePolicy.promptVersion,
                                schemaVersion: stagePolicy.schemaVersion,
                                maxOutputTokens: resolvedMaxOutputTokens
                                    ?? stagePolicy.maxOutputTokens,
                                attempt: attemptNumber,
                                retryCount: attemptNumber - 1,
                            });
                        } catch (error) {
                            if (
                                error instanceof Error
                                && AI_ADMISSION_SIGNAL_CODES.has(error.message)
                            ) {
                                throw error;
                            }
                            throw new Error(
                                'AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR: Gemini attempt intent was not durably stored.'
                            );
                        }
                    }

                    return client.models.generateContent({
                        model: modelName,
                        contents: [{ role: 'user', parts }],
                        config,
                    });
                });
            } catch (generationError) {
                if (
                    generationError instanceof Error
                    && (
                        generationError.message.startsWith(
                            'AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR:'
                        )
                        || AI_ADMISSION_SIGNAL_CODES.has(generationError.message)
                    )
                ) {
                    throw generationError;
                }
                const disposition = classifyGeminiGenerationError(generationError);
                await emitAttemptTelemetry({
                    tokenUsage: null,
                    usageComplete: false,
                    usageMetadataStatus: 'missing',
                    modelName,
                    location: GOOGLE_CLOUD_LOCATION,
                    stage: stage ?? null,
                    thinkingLevel: resolvedThinkingLevel,
                    mediaCount: selectedImages.length,
                    mediaResolution: resolvedMediaResolution,
                    promptVersion: stagePolicy?.promptVersion ?? null,
                    schemaVersion: stagePolicy?.schemaVersion ?? null,
                    maxOutputTokens: resolvedMaxOutputTokens ?? null,
                    latencyMs: Math.max(0, Math.round(performance.now() - attemptStartedAt)),
                    estimatedCostUsd: null,
                    attempt: attemptNumber,
                    retryCount: attemptNumber - 1,
                    disposition,
                    finishReason: null,
                }, onAttemptTelemetry);
                throw sanitizeGenerationError(generationError);
            }

            const usage = extractStrictUsageMetadata(response.usageMetadata);
            const costEstimate = usage.tokenUsage
                ? estimateGeminiRequestCost(
                    usage.tokenUsage,
                    modelName,
                    GOOGLE_CLOUD_LOCATION
                )
                : null;
            const finishReason = readSingleCandidateFinishReason(response);
            let parsed: T | undefined;
            let completionError: Error | null = null;
            try {
                const text = extractSuccessfulCandidateText(response);
                parsed = parseGeminiJsonResponse(text, schema);
            } catch (error) {
                completionError = error instanceof Error ? error : new Error('Gemini response rejected');
            }

            const attemptTelemetry: GeminiAttemptTelemetry = {
                tokenUsage: usage.tokenUsage,
                usageComplete: usage.status === 'complete',
                usageMetadataStatus: usage.status,
                modelName,
                location: GOOGLE_CLOUD_LOCATION,
                stage: stage ?? null,
                thinkingLevel: resolvedThinkingLevel,
                mediaCount: selectedImages.length,
                mediaResolution: resolvedMediaResolution,
                promptVersion: stagePolicy?.promptVersion ?? null,
                schemaVersion: stagePolicy?.schemaVersion ?? null,
                maxOutputTokens: resolvedMaxOutputTokens ?? null,
                latencyMs: Math.max(0, Math.round(performance.now() - attemptStartedAt)),
                estimatedCostUsd: costEstimate?.totalCostUsd ?? null,
                attempt: attemptNumber,
                retryCount: attemptNumber - 1,
                disposition: completionError ? 'response_rejected' : 'success',
                finishReason,
            };

            // V2 persists the validated result and attempt outcome before any best-effort legacy log.
            await emitAttemptTelemetry(
                attemptTelemetry,
                onAttemptTelemetry,
                completionError ? undefined : parsed
            );

            // The legacy table cannot represent unknown usage. Never persist a fabricated zero.
            if (!skipTokenLog && usage.tokenUsage) {
                await logTokenUsage(usage.tokenUsage, analysisType, requestId, false, modelName, {
                    latencyMs: attemptTelemetry.latencyMs,
                    location: attemptTelemetry.location,
                    estimatedCostUsd: attemptTelemetry.estimatedCostUsd,
                });
            }

            if (completionError) {
                throw new Error(
                    `${AI_GENERATION_RESPONSE_REJECTED_ERROR_PREFIX} generated response failed strict validation.`
                );
            }

            const telemetry: GeminiRequestTelemetry = {
                tokenUsage: attemptTelemetry.tokenUsage,
                usageComplete: attemptTelemetry.usageComplete,
                usageMetadataStatus: attemptTelemetry.usageMetadataStatus,
                modelName: attemptTelemetry.modelName,
                location: attemptTelemetry.location,
                stage: attemptTelemetry.stage,
                thinkingLevel: attemptTelemetry.thinkingLevel,
                mediaCount: attemptTelemetry.mediaCount,
                mediaResolution: attemptTelemetry.mediaResolution,
                promptVersion: attemptTelemetry.promptVersion,
                schemaVersion: attemptTelemetry.schemaVersion,
                maxOutputTokens: attemptTelemetry.maxOutputTokens,
                latencyMs: Math.max(0, Math.round(performance.now() - analysisStartedAt)),
                estimatedCostUsd: attemptTelemetry.estimatedCostUsd,
            };
            console.log('Gemini request telemetry:', telemetry);
            if (onTelemetry) {
                try {
                    await onTelemetry(telemetry);
                } catch {
                    console.warn('Gemini telemetry hook failed');
                }
            }
            console.log('--- AnalyzeWithGemini End (Success) ---');

            return parsed as T;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.error(`Gemini API Error (attempt ${attemptNumber}):`, lastError.message);

            // 재시도 불가능한 에러거나 마지막 시도면 throw
            if (!(error instanceof RetryableGeminiRateLimitError)
                || attemptNumber >= RETRY_CONFIG.maxRetries + 1) {
                console.error('--- AnalyzeWithGemini End (Failed) ---');
                throw lastError;
            }
        }
    }

    // 이론적으로 도달 불가능하지만 TypeScript를 위해
    throw lastError || new Error('Unknown error');
}

/**
 * 이미지 URL을 base64로 변환
 * Instagram CDN URL은 지역 기반이라 Vercel 서버에서 직접 접근이 불가할 수 있음
 * 실패 시 외부 프록시 서비스(weserv.nl)를 통해 재시도
 */
export async function imageUrlToBase64(url: string): Promise<string> {
    return imageUrlToNormalizedBase64(url);
}

/**
 * 일별 토큰 사용량 조회
 */
export async function getDailyTokenUsage(days: number = 7): Promise<{
    date: string;
    analysisType: string;
    modelName: string;
    apiCalls: number;
    cacheHits: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
    latencySamples: number;
    averageLatencyMs: number | null;
}[]> {
    const { data, error } = await supabaseAdmin
        .from('gemini_token_usage')
        .select('*')
        .gte('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Failed to get token usage:', error);
        return [];
    }

    // 일별 집계
    const dailyStats = new Map<string, {
        date: string;
        analysisType: string;
        modelName: string;
        apiCalls: number;
        cacheHits: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedCostUsd: number | null;
        latencySamples: number;
        totalLatencyMs: number;
    }>();

    for (const row of data || []) {
        const date = new Date(row.created_at).toISOString().split('T')[0];
        const modelName = row.model_name || 'unknown';
        const key = `${date}-${row.analysis_type}-${modelName}`;

        const existing = dailyStats.get(key) || {
            date,
            analysisType: row.analysis_type,
            modelName,
            apiCalls: 0,
            cacheHits: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            estimatedCostUsd: 0,
            latencySamples: 0,
            totalLatencyMs: 0,
        };

        const tokenUsage: TokenUsage = {
            promptTokens: row.prompt_tokens ?? 0,
            completionTokens: row.completion_tokens ?? 0,
            totalTokens: row.total_tokens ?? 0,
            thinkingTokens: row.thinking_tokens ?? undefined,
        };
        const calculatedCost = estimateGeminiRequestCost(
            tokenUsage,
            modelName,
            row.model_location || GOOGLE_CLOUD_LOCATION
        );
        const storedCost = Number(row.estimated_cost_usd);
        const estimatedCostUsd = row.estimated_cost_usd !== null
            && row.estimated_cost_usd !== undefined
            && Number.isFinite(storedCost)
            ? storedCost
            : calculatedCost?.totalCostUsd ?? null;
        const latencyMs = Number(row.latency_ms);

        existing.apiCalls += row.cached_hit ? 0 : 1;
        existing.cacheHits += row.cached_hit ? 1 : 0;
        existing.promptTokens += tokenUsage.promptTokens;
        existing.completionTokens += tokenUsage.completionTokens;
        existing.totalTokens += tokenUsage.totalTokens;
        existing.estimatedCostUsd = existing.estimatedCostUsd === null || estimatedCostUsd === null
            ? null
            : Number((existing.estimatedCostUsd + estimatedCostUsd).toFixed(12));
        if (row.latency_ms !== null && row.latency_ms !== undefined && Number.isFinite(latencyMs)) {
            existing.latencySamples += 1;
            existing.totalLatencyMs += latencyMs;
        }

        dailyStats.set(key, existing);
    }

    return Array.from(dailyStats.values()).map(({ totalLatencyMs, ...stats }) => ({
        ...stats,
        averageLatencyMs: stats.latencySamples > 0
            ? Math.round(totalLatencyMs / stats.latencySamples)
            : null,
    }));
}
