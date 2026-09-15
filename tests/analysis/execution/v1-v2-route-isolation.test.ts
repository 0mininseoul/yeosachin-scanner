import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('V1 route isolation from durable V2 requests', () => {
    it('routes every public intake through preflight instead of the legacy start endpoint', () => {
        const landingPage = source('components/landing-page.tsx');
        const landingEntry = source('app/page.tsx');
        const analyzePage = source('app/analyze/page.tsx');
        const preflightHook = source('hooks/useAnalysisV2Preflight.ts');

        expect(landingPage).not.toContain("fetch('/api/analysis/start'");
        expect(landingEntry).toContain("import LandingPage from '@/components/landing-page'");
        expect(analyzePage).not.toContain("fetch('/api/analysis/start'");
        expect(preflightHook).toContain("fetch('/api/analysis/preflight'");
        expect(preflightHook).toContain("method: 'PATCH'");
        expect(preflightHook).toContain('/entitle`');
        expect(preflightHook).toContain('X-Analysis-Test-Entitlement');
    });

    it('preserves landing autostart through authentication and renders server plan limits', () => {
        const landingPage = source('components/landing-page.tsx');
        const landingEntry = source('app/page.tsx');
        const analyzePage = source('app/analyze/page.tsx');
        const proxy = source('proxy.ts');

        expect(landingEntry).toContain('<LandingPage />');
        expect(landingPage).toContain("loginRedirectTo = '/analyze?autostart=1'");
        expect(landingPage).toContain('redirectTo={loginRedirectTo}');
        expect(landingPage).toContain('국내 유일 위장여사친 판독 서비스');
        expect(landingPage).toContain('내 남친이 맞팔 중인 여자들,');
        expect(landingPage).toContain('누가 제일 위험할까?');
        expect(landingPage).toContain('지금 바로 위장 여사친 확인하기');
        expect(proxy).toContain('request.nextUrl.search');
        expect(proxy).toContain("request.nextUrl.searchParams.get('redirectTo')");
        expect(proxy).toContain('appRedirectUrlForRequest(');
        expect(proxy).toContain('redirectResponse.cookies.set(cookie)');
        expect(analyzePage).toContain('plan.relationshipCapacity');
        expect(analyzePage).not.toContain("capacity: '팔로워·팔로잉 각 400명 이하'");
    });

    it('never runs status-driven V1 stale cleanup for a V2 request', () => {
        const route = source('app/api/analysis/status/[requestId]/route.ts');

        expect(route).toContain('pipeline_version');
        expect(route).toContain('isV1Pipeline(analysisRequest.pipeline_version)');
        expect(route.indexOf('isV1Pipeline(analysisRequest.pipeline_version)'))
            .toBeLessThan(route.indexOf('expireStaleAnalysisBeforeStart(undefined'));
    });

    it('only selects V1 work for start-driven stale cleanup', () => {
        const route = source('app/api/analysis/start/route.ts');
        const cleanupStart = route.indexOf('await expireStaleAnalysisBeforeStart');
        const cleanupEnd = route.indexOf('let analysisRequest;', cleanupStart);
        const cleanupBlock = route.slice(cleanupStart, cleanupEnd);

        expect(cleanupBlock).toContain(
            ".or('pipeline_version.eq.v1,pipeline_version.is.null')"
        );
        expect(cleanupBlock).toContain('abortRunningAnalysisProviderRuns');
        expect(cleanupBlock).toContain('failAnalysisRequest');
    });

    it('puts every legacy V1 provider producer behind the active freeze gate', () => {
        for (const routePath of [
            'app/api/analysis/start/route.ts',
            'app/api/analysis/step/route.ts',
            'app/api/analysis/run/route.ts',
        ]) {
            const route = source(routePath);
            expect(route).toContain('legacyAnalysisProducerGateResponse');
            // Compare executable calls, not import declarations.  The gate must
            // run before a Supabase client is created on every public producer.
            const gateCall = route.indexOf('legacyAnalysisProducerGateResponse();');
            const clientCall = route.indexOf('createClient()');
            expect(gateCall).toBeGreaterThanOrEqual(0);
            expect(clientCall).toBeGreaterThan(gateCall);
        }
    });

    it('makes both shared pages follow an explicit V2 route marker', () => {
        const progressHook = source('hooks/useAnalysisProgress.ts');
        const progressPage = source('app/progress/[requestId]/page.tsx');
        const resultPage = source('app/result/[requestId]/page.tsx') + '\n' + source('app/result/[requestId]/result-view-model.ts');

        expect(progressHook).toContain("payload.code === 'V2_ROUTE_REQUIRED'");
        expect(progressHook).toContain("payload.progressUrl.startsWith('/api/analysis/progress/')");
        expect(progressHook).toContain('analysisV2ProgressCopy({');
        expect(progressHook).toContain('activeProfile: progress.snapshot.activeProfile');
        expect(progressHook).toContain("table: 'analysis_progress_state'");
        expect(progressHook).toContain("table: 'analysis_progress_events'");
        expect(progressHook).toContain('mergeProgressEvents(');
        expect(progressPage).toContain("data.pipelineVersion === 'v2'");
        expect(progressPage).toContain("data?.pipelineVersion === 'v2'");
        expect(resultPage).toContain("result.code === 'V2_ROUTE_REQUIRED'");
        expect(resultPage).toContain("result.resultUrl.startsWith('/api/analysis/v2/result/')");
        expect(resultPage).toContain('v2ResultFailureAction({');
        expect(resultPage).toContain('resultPaginationModel({');
        expect(resultPage).toContain('boundedOwnerResultPage(result.femaleAccounts)');
        expect(resultPage).toContain('? next.femaleAccounts');
        expect(resultPage).toContain('setPageError(action)');
        expect(resultPage).not.toContain('appendUniqueAccounts');
    });
});
