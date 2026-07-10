import type { InstagramFollower } from '@/lib/types/instagram';
import type { ProviderCallContext, ScraperProvider } from './types';
import { isInstagramUsername } from '../username';

const RAPIDAPI_FOLLOWING_PATH = '/get_ig_user_followers_v2.php';
const MAX_RELATIONSHIP_LIMIT = 500_000;

function getRapidApiConfig() {
    const key = process.env.STABLE_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY;
    const host = process.env.STABLE_RAPIDAPI_HOST;
    const rawEstimatedCost = process.env.STABLE_RAPIDAPI_ESTIMATED_COST_PER_REQUEST_USD;
    const timeoutMs = Number(process.env.STABLE_RAPIDAPI_TIMEOUT_MS ?? 30_000);
    if (!key || !host) {
        throw new Error('SCRAPING_CONFIG_ERROR: STABLE_RAPIDAPI_HOST와 Stable API key가 설정되지 않았습니다.');
    }
    if (host === 'flashapi1.p.rapidapi.com') {
        throw new Error('SCRAPING_CONFIG_ERROR: Stable API host에 FlashAPI host를 사용할 수 없습니다.');
    }
    const estimatedCostPerRequestUsd = Number(rawEstimatedCost);
    if (
        !rawEstimatedCost ||
        !Number.isFinite(estimatedCostPerRequestUsd) ||
        estimatedCostPerRequestUsd <= 0 ||
        estimatedCostPerRequestUsd > 100
    ) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: STABLE_RAPIDAPI_ESTIMATED_COST_PER_REQUEST_USD를 양수로 설정해야 합니다.'
        );
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: STABLE_RAPIDAPI_TIMEOUT_MS는 1000~120000 범위의 정수여야 합니다.'
        );
    }
    return { key, host, baseUrl: `https://${host}`, estimatedCostPerRequestUsd, timeoutMs };
}

function extractUserList(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') {
        throw new Error('SCRAPING_SCHEMA_ERROR: Stable API 목록 응답이 객체나 배열이 아닙니다.');
    }
    const record = data as Record<string, unknown>;
    for (const key of ['data', 'users', 'items', 'followers', 'following']) {
        const value = record[key];
        if (Array.isArray(value)) return value;
    }
    if ('0' in record) return Object.values(record);
    throw new Error('SCRAPING_SCHEMA_ERROR: Stable API 목록 배열을 찾을 수 없습니다.');
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
        throw new Error(`SCRAPING_SCHEMA_ERROR: Stable API ${field}가 문자열이 아닙니다.`);
    }
    return value;
}

function mapFollowerItem(item: unknown): InstagramFollower {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('SCRAPING_SCHEMA_ERROR: Stable API 사용자 행이 객체가 아닙니다.');
    }
    const record = item as Record<string, unknown>;
    const user = record.user && typeof record.user === 'object' && !Array.isArray(record.user)
        ? (record.user as Record<string, unknown>)
        : record;
    const username = typeof user.username === 'string' ? user.username.trim() : '';
    if (!isInstagramUsername(username)) {
        throw new Error('SCRAPING_SCHEMA_ERROR: Stable API username이 올바르지 않습니다.');
    }
    const isPrivate = user.is_private ?? user.isPrivate ?? false;
    const isVerified = user.is_verified ?? user.isVerified ?? false;
    if (typeof isPrivate !== 'boolean' || typeof isVerified !== 'boolean') {
        throw new Error('SCRAPING_SCHEMA_ERROR: Stable API privacy flags가 올바르지 않습니다.');
    }

    return {
        username,
        fullName: optionalString(user.full_name ?? user.fullName, 'full_name'),
        profilePicUrl: optionalString(
            user.profile_pic_url ?? user.profilePicUrl,
            'profile_pic_url'
        ),
        isPrivate,
        isVerified,
    };
}

async function getFollowing(
    username: string,
    limit: number = 500,
    context?: ProviderCallContext
): Promise<InstagramFollower[]> {
    const normalizedUsername = username.trim().replace(/^@/, '');
    if (!isInstagramUsername(normalizedUsername)) {
        throw new Error('SCRAPING_CONFIG_ERROR: Instagram username 형식이 올바르지 않습니다.');
    }
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_RELATIONSHIP_LIMIT) {
        throw new Error(
            `SCRAPING_CONFIG_ERROR: limit은 0~${MAX_RELATIONSHIP_LIMIT} 범위의 정수여야 합니다.`
        );
    }
    if (limit === 0) return [];

    const { key, host, baseUrl, estimatedCostPerRequestUsd, timeoutMs } = getRapidApiConfig();
    const body = new URLSearchParams({
        username_or_url: normalizedUsername,
        data: 'following',
        amount: String(limit),
    });

    context?.recordUsage({
        request_count: 1,
        estimated_cost_usd: estimatedCostPerRequestUsd,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
        response = await fetch(`${baseUrl}${RAPIDAPI_FOLLOWING_PATH}`, {
            method: 'POST',
            headers: {
                'x-rapidapi-key': key,
                'x-rapidapi-host': host,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
            signal: controller.signal,
        });
        text = await response.text();
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(
                'SCRAPING_PAID_REQUEST_AMBIGUOUS_ERROR: Stable API 요청 시간이 초과되었습니다.'
            );
        }
        throw new Error(
            'SCRAPING_PAID_REQUEST_AMBIGUOUS_ERROR: Stable API transport request failed.'
        );
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        throw new Error(
            `SCRAPING_PAID_REQUEST_ERROR: 팔로잉 수집에 실패했습니다. HTTP ${response.status}`
        );
    }
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('SCRAPING_SCHEMA_ERROR: Stable API가 유효한 JSON을 반환하지 않았습니다.');
    }
    if (data && typeof data === 'object' && ('error' in data || 'message' in data)) {
        throw new Error('SCRAPING_PAID_REQUEST_ERROR: Stable API가 오류 응답을 반환했습니다.');
    }

    const rawItems = extractUserList(data);
    context?.recordUsage({ raw_result_count: rawItems.length });
    const unique = new Map<string, InstagramFollower>();
    for (const item of rawItems.map(mapFollowerItem)) {
        const key = item.username.toLowerCase();
        if (!unique.has(key)) unique.set(key, item);
    }
    const items = [...unique.values()].slice(0, limit);

    if (items.length === 0) {
        throw new Error(
            'SCRAPING_PAID_REQUEST_ERROR: 팔로잉 목록을 가져올 수 없습니다. 계정 접근이 제한되었을 수 있습니다.'
        );
    }
    context?.recordUsage({
        result_count: items.length,
        unique_result_count: unique.size,
    });
    return items;
}

export const rapidApiProvider: ScraperProvider = {
    name: 'rapidapi',
    paid: true,
    getFollowing,
};
