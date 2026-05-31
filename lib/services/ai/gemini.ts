import { writeFileSync } from 'fs';
import { join } from 'path';
import { GoogleGenAI, type Part } from '@google/genai';
import { supabaseAdmin } from '@/lib/supabase/admin';

const VERTEX_AI_MODEL = process.env.VERTEX_AI_MODEL || 'gemini-3-flash-preview';
const GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'global';

let genAI: GoogleGenAI | null = null;
let credentialsPrepared = false;

function prepareGoogleCredentials(): void {
    if (credentialsPrepared) {
        return;
    }

    credentialsPrepared = true;

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
        return;
    }

    const credentialsJson = Buffer.from(
        process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64,
        'base64'
    ).toString('utf8');

    JSON.parse(credentialsJson);

    const credentialsPath = join('/tmp', 'google-service-account.json');
    writeFileSync(credentialsPath, credentialsJson, { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
}

function getGenAIClient(): GoogleGenAI {
    if (genAI) {
        return genAI;
    }

    prepareGoogleCredentials();

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
}

// 분석 결과 + 토큰 사용량
export interface AnalysisResult<T> {
    data: T;
    tokenUsage: TokenUsage;
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

/**
 * 재시도 가능한 에러인지 확인
 */
function isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        // Rate limit, 서버 에러, 네트워크 에러는 재시도
        return (
            message.includes('rate limit') ||
            message.includes('429') ||
            message.includes('500') ||
            message.includes('503') ||
            message.includes('timeout') ||
            message.includes('network') ||
            message.includes('econnreset') ||
            message.includes('fetch failed')
        );
    }
    return false;
}

/**
 * 토큰 사용량을 DB에 저장
 */
export async function logTokenUsage(
    tokenUsage: TokenUsage,
    analysisType: string,
    requestId?: string,
    cachedHit: boolean = false
): Promise<void> {
    try {
        await supabaseAdmin.from('gemini_token_usage').insert({
            request_id: requestId || null,
            prompt_tokens: tokenUsage.promptTokens,
            completion_tokens: tokenUsage.completionTokens,
            total_tokens: tokenUsage.totalTokens,
            analysis_type: analysisType,
            model_name: VERTEX_AI_MODEL,
            cached_hit: cachedHit,
        });
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
    images?: string[],
    options?: {
        analysisType?: string;
        requestId?: string;
        skipTokenLog?: boolean;
    }
): Promise<T> {
    const { analysisType = 'unknown', requestId, skipTokenLog = false } = options || {};

    console.log('--- AnalyzeWithGemini Start ---');
    console.log('Analysis type:', analysisType);
    console.log('Image count:', images?.length ?? 0);

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
                for (const image of images) {
                    parts.push({
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: image,
                        },
                    });
                }
            }

            const response = await client.models.generateContent({
                model: VERTEX_AI_MODEL,
                contents: [{ role: 'user', parts }],
            });
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
            };

            console.log('Token usage:', tokenUsage);

            // 토큰 사용량 DB 저장
            if (!skipTokenLog) {
                await logTokenUsage(tokenUsage, analysisType, requestId, false);
            }

            // JSON 파싱
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error('JSON Parse Failed. Response length:', text.length);
                throw new Error('Failed to parse AI response as JSON');
            }

            const parsed = JSON.parse(jsonMatch[0]) as T;
            console.log('--- AnalyzeWithGemini End (Success) ---');

            return parsed;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.error(`Gemini API Error (attempt ${attempt + 1}):`, lastError.message);

            // 재시도 불가능한 에러거나 마지막 시도면 throw
            if (!isRetryableError(error) || attempt >= RETRY_CONFIG.maxRetries) {
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15초 타임아웃

    try {
        // 1차 시도: 직접 fetch
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                'Referer': 'https://www.instagram.com/',
            },
        });

        if (response.ok) {
            const buffer = await response.arrayBuffer();
            return Buffer.from(buffer).toString('base64');
        }

        throw new Error(`Direct fetch failed: ${response.status}`);
    } catch (directError) {
        // 2차 시도: weserv.nl 프록시 사용
        console.log(`Direct fetch failed for ${url.substring(0, 50)}..., trying proxy`, directError);

        try {
            const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(url)}&default=1`;
            const proxyResponse = await fetch(proxyUrl, {
                signal: controller.signal,
            });

            if (!proxyResponse.ok) {
                throw new Error(`Proxy fetch failed: ${proxyResponse.status}`);
            }

            const buffer = await proxyResponse.arrayBuffer();
            return Buffer.from(buffer).toString('base64');
        } catch (proxyError) {
            console.warn(`Failed to convert image via proxy: ${url.substring(0, 80)}...`, proxyError);
            throw proxyError;
        }
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * 일별 토큰 사용량 조회
 */
export async function getDailyTokenUsage(days: number = 7): Promise<{
    date: string;
    analysisType: string;
    apiCalls: number;
    cacheHits: number;
    totalTokens: number;
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
        apiCalls: number;
        cacheHits: number;
        totalTokens: number;
    }>();

    for (const row of data || []) {
        const date = new Date(row.created_at).toISOString().split('T')[0];
        const key = `${date}-${row.analysis_type}`;

        const existing = dailyStats.get(key) || {
            date,
            analysisType: row.analysis_type,
            apiCalls: 0,
            cacheHits: 0,
            totalTokens: 0,
        };

        existing.apiCalls += 1;
        existing.cacheHits += row.cached_hit ? 1 : 0;
        existing.totalTokens += row.total_tokens;

        dailyStats.set(key, existing);
    }

    return Array.from(dailyStats.values());
}
