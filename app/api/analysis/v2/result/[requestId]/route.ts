import { z } from 'zod';
import { NextResponse } from 'next/server';
import { analysisResultPageV1Schema } from '@/lib/contracts/analysis-v2';
import {
    RESULT_PAGE_SIZE_DEFAULT,
    RESULT_PAGE_SIZE_MAX,
    decodeResultCursor,
    type ResultListKind,
} from '@/lib/domain/analysis/result-pagination';
import { analysisV2ResultStore } from '@/lib/services/analysis/v2-result-store';
import { createClient } from '@/lib/supabase/server';
import { demoResponseHeaders, demoResultPageFromFixture, isDemoOperator } from '@/lib/services/demo-analysis/demo-analysis';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';
import { loadDemoFixtureForVersion } from '@/lib/services/demo-analysis/fixture-store';
import {
    isAnalysisResultOperator,
    resolveAnalysisResultOwner,
} from '@/lib/services/analysis/result-operator-access';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
} from '@/lib/services/identity/account-principal-store';

const requestIdSchema = z.string().uuid();
const pageSizeSchema = z.string().regex(/^\d{1,2}$/).transform(Number)
    .pipe(z.number().int().min(1).max(RESULT_PAGE_SIZE_MAX));

const PRIVATE_NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
} as const;

function json(body: unknown, status: number) {
    return NextResponse.json(body, {
        status,
        headers: PRIVATE_NO_STORE_HEADERS,
    });
}

function demoJson(body: unknown, status: number) {
    return NextResponse.json(body, { status, headers: demoResponseHeaders() });
}

function parseCursor(value: string | null, list: ResultListKind): string | null {
    if (value === null) return null;
    const cursor = decodeResultCursor(value);
    if (cursor.list !== list) throw new Error('RESULT_CURSOR_SCOPE_MISMATCH');
    return value;
}

async function handleGET(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> },
    context: OperationalRequestContext,
) {
    const requestId = requestIdSchema.safeParse((await params).requestId);
    if (!requestId.success) {
        return json({ error: 'Invalid result request.' }, 400);
    }
    const url = new URL(request.url);
    let demoRecognized = false;

    try {
        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            return json({ error: 'Authentication required.' }, 401);
        }
        try {
            await requireActiveAccountClassification(user.id);
        } catch (accountError) {
            if (accountError instanceof AccountPrincipalAdmissionError) {
                return json({ error: 'Account unavailable.' }, 403);
            }
            throw accountError;
        }

        const demo = await demoAnalysisStore.findForOwner(requestId.data, user.id);
        demoRecognized = demo !== null;

        const pageSize = url.searchParams.has('pageSize')
            ? pageSizeSchema.safeParse(url.searchParams.get('pageSize'))
            : { success: true as const, data: RESULT_PAGE_SIZE_DEFAULT };
        let femaleCursor: string | null;
        let privateCursor: string | null;
        try {
            femaleCursor = parseCursor(url.searchParams.get('femaleCursor'), 'public');
            privateCursor = parseCursor(url.searchParams.get('privateCursor'), 'private');
        } catch {
            return demoRecognized
                ? demoJson({ error: 'Invalid result request.' }, 400)
                : json({ error: 'Invalid result request.' }, 400);
        }
        if (!pageSize.success) {
            return demoRecognized
                ? demoJson({ error: 'Invalid result request.' }, 400)
                : json({ error: 'Invalid result request.' }, 400);
        }

        if (demo) {
            if (demo.user_id !== user.id || !isDemoOperator(user.id) || !demo.started_at || Date.now() < new Date(demo.started_at).getTime() + demo.duration_seconds * 1_000) {
                return demoJson({ error: 'Analysis result not found.' }, 404);
            }
            const fixture = await loadDemoFixtureForVersion(demo.fixture_version);
            if (!fixture) return demoJson({ error: 'Demo fixture is unavailable.' }, 503);
            return demoJson(analysisResultPageV1Schema.parse(demoResultPageFromFixture(fixture.fixture, {
                requestId: demo.id,
                femaleCursor,
                privateCursor,
                pageSize: pageSize.data,
            })), 200);
        }

        const operator = isAnalysisResultOperator({ id: user.id, email: user.email });
        const authorizedOwnerId = operator
            ? await resolveAnalysisResultOwner(requestId.data)
            : user.id;
        if (!authorizedOwnerId) {
            return json({ error: 'Analysis result not found.' }, 404);
        }

        if (!await isAnalysisResultAuthoritativelyPublished(requestId.data)) {
            return json({
                error: 'Analysis result is still pending publication.',
                code: 'RESULT_PENDING',
                status: 'pending',
            }, 404);
        }

        const result = await analysisV2ResultStore.loadPage({
            requestId: requestId.data,
            userId: authorizedOwnerId,
            femaleCursor,
            privateCursor,
            pageSize: pageSize.data,
        });
        if (!result) {
            return json({ error: 'Analysis result not found.' }, 404);
        }

        const response = json(analysisResultPageV1Schema.parse(result), 200);
        if (
            !url.searchParams.has('femaleCursor')
            && !url.searchParams.has('privateCursor')
        ) {
            operationalLogger.emit({
                event: 'analysis_v2.result_viewed',
                severity: 'info',
                fields: {
                    ...context,
                    user_id: user.id,
                    analysis_request_id: requestId.data,
                    operation: 'result',
                    disposition: 'success',
                },
            });
        }
        return response;
    } catch {
        console.error('[analysis-v2-result] owner result read failed');
        return demoRecognized
            ? demoJson({ error: 'Result could not be loaded.' }, 500)
            : json({ error: 'Result could not be loaded.' }, 500);
    }
}

export async function GET(
    request: Request,
    routeContext: { params: Promise<{ requestId: string }> },
) {
    return observeRoute(
        request,
        '/api/analysis/v2/result/[requestId]',
        context => handleGET(request, routeContext, context),
    );
}
