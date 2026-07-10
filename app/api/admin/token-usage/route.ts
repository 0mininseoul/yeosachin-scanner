import { NextResponse } from 'next/server';
import { getDailyTokenUsage } from '@/lib/services/ai/gemini';
import { getCacheStats } from '@/lib/services/ai/combined-analysis';
import { hasValidAdminAuthorization } from '@/lib/services/instagram/admin-selection';

/**
 * 토큰 사용량 및 캐시 통계 조회 API
 * GET /api/admin/token-usage?days=7
 */
export async function GET(request: Request) {
    if (!hasValidAdminAuthorization(request.headers.get('authorization'))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { searchParams } = new URL(request.url);
        const days = parseInt(searchParams.get('days') || '7', 10);

        const [tokenUsage, cacheStats] = await Promise.all([
            getDailyTokenUsage(days),
            getCacheStats(),
        ]);

        // 요약 통계 계산
        const summary = {
            totalApiCalls: tokenUsage.reduce((sum, d) => sum + d.apiCalls, 0),
            totalCacheHits: tokenUsage.reduce((sum, d) => sum + d.cacheHits, 0),
            totalTokens: tokenUsage.reduce((sum, d) => sum + d.totalTokens, 0),
            cacheHitRate: 0,
            estimatedCostUsd: Number(tokenUsage.reduce(
                (sum, day) => sum + (day.estimatedCostUsd ?? 0),
                0
            ).toFixed(12)),
            costEstimateComplete: tokenUsage.every(day => day.estimatedCostUsd !== null),
            averageLatencyMs: null as number | null,
        };

        // 캐시 히트율 계산
        if (summary.totalApiCalls + summary.totalCacheHits > 0) {
            summary.cacheHitRate = Math.round(
                (summary.totalCacheHits / (summary.totalApiCalls + summary.totalCacheHits)) * 100
            );
        }

        const latencySamples = tokenUsage.reduce((sum, day) => sum + day.latencySamples, 0);
        if (latencySamples > 0) {
            const totalLatencyMs = tokenUsage.reduce(
                (sum, day) => sum + (day.averageLatencyMs ?? 0) * day.latencySamples,
                0
            );
            summary.averageLatencyMs = Math.round(totalLatencyMs / latencySamples);
        }

        return NextResponse.json({
            success: true,
            period: `Last ${days} days`,
            summary,
            cache: cacheStats,
            daily: tokenUsage,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get token usage';
        console.error(`Token usage API error: ${message}`);
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}
