import {
    GoogleGenAI,
    MediaResolution,
    ThinkingLevel,
    type Part,
} from '@google/genai';
import type { ZodType } from 'zod';
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
    classifyGeminiGenerationError,
} from './gemini-generation-policy';

const GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'global';

let genAI: GoogleGenAI | null = null;
let extendedTelemetrySupported: boolean | null = null;

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

export interface GeminiRequestTelemetry {
    tokenUsage: TokenUsage;
    modelName: string;
    location: string;
    latencyMs: number;
    estimatedCostUsd: number | null;
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
        super('AI_RATE_LIMIT_ERROR: Gemini rejected the request due to rate limiting.');
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
    options: {
        schema: ZodType<T>;
        analysisType?: string;
        requestId?: string;
        skipTokenLog?: boolean;
        maxOutputTokens?: number;
        onTelemetry?: (telemetry: GeminiRequestTelemetry) => void | Promise<void>;
    }
): Promise<T> {
    const {
        analysisType = 'unknown',
        requestId,
        skipTokenLog = false,
        maxOutputTokens,
        onTelemetry,
        schema,
    } = options;
    if (
        maxOutputTokens !== undefined
        && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65_536)
    ) {
        throw new Error('Gemini maxOutputTokens must be an integer from 1 to 65536');
    }
    const costOptimized = isVertexAICostOptimized();
    const modelName = resolveVertexAIModel(process.env.VERTEX_AI_MODEL, costOptimized);
    const imagePolicy = getAnalysisImagePolicy(costOptimized);
    const analysisStartedAt = performance.now();

    console.log('--- AnalyzeWithGemini Start ---');
    console.log('Analysis type:', analysisType);
    console.log('Image count:', Math.min(images?.length ?? 0, imagePolicy.maxImages));

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                const delay = getRetryDelay(attempt - 1);
                console.log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries} after ${delay}ms`);
                await sleep(delay);
            }

            const client = getGenAIClient();

            const parts: Part[] = [{ text: prompt }];

            // 이미지가 있으면 추가
            if (images && images.length > 0) {
                for (const image of images.slice(0, imagePolicy.maxImages)) {
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
                response = await client.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts }],
                    ...(costOptimized || maxOutputTokens !== undefined
                        ? {
                            config: {
                                maxOutputTokens: maxOutputTokens ?? 1_024,
                                responseMimeType: 'application/json',
                                ...(costOptimized
                                    ? {
                                        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
                                        ...(modelName.startsWith('gemini-3')
                                            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
                                            : {}),
                                    }
                                    : {}),
                            },
                        }
                        : {}),
                });
            } catch (generationError) {
                throw sanitizeGenerationError(generationError);
            }
            const text = response.text;

            if (!text) {
                throw new Error('Gemini response did not include text');
            }

            // 토큰 사용량 추출
            const usageMetadata = response.usageMetadata;
            const tokenUsage: TokenUsage = {
                promptTokens: usageMetadata?.promptTokenCount ?? 0,
                completionTokens: usageMetadata?.candidatesTokenCount ?? 0,
                totalTokens: usageMetadata?.totalTokenCount ?? 0,
                thinkingTokens: usageMetadata?.thoughtsTokenCount ?? 0,
            };
            const costEstimate = estimateGeminiRequestCost(
                tokenUsage,
                modelName,
                GOOGLE_CLOUD_LOCATION
            );
            const telemetry: GeminiRequestTelemetry = {
                tokenUsage,
                modelName,
                location: GOOGLE_CLOUD_LOCATION,
                latencyMs: Math.max(0, Math.round(performance.now() - analysisStartedAt)),
                estimatedCostUsd: costEstimate?.totalCostUsd ?? null,
            };

            console.log('Token usage:', tokenUsage);
            console.log('Gemini request telemetry:', telemetry);

            // 토큰 사용량 DB 저장
            if (!skipTokenLog) {
                await logTokenUsage(tokenUsage, analysisType, requestId, false, modelName, {
                    latencyMs: telemetry.latencyMs,
                    location: telemetry.location,
                    estimatedCostUsd: telemetry.estimatedCostUsd,
                });
            }

            if (onTelemetry) {
                try {
                    await onTelemetry(telemetry);
                } catch (telemetryError) {
                    console.warn('Gemini telemetry hook failed:', telemetryError);
                }
            }

            const parsed = parseGeminiJsonResponse(text, schema);
            console.log('--- AnalyzeWithGemini End (Success) ---');

            return parsed;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.error(`Gemini API Error (attempt ${attempt + 1}):`, lastError.message);

            // 재시도 불가능한 에러거나 마지막 시도면 throw
            if (!(error instanceof RetryableGeminiRateLimitError)
                || attempt >= RETRY_CONFIG.maxRetries) {
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
