import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('V1 route isolation from durable V2 requests', () => {
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
});
