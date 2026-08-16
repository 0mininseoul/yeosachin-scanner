import { z } from 'zod';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ANALYSIS_V2_SCHEMA_VERSION, progressReadV1Schema } from '@/lib/contracts/analysis-v2';
import { analysisV2ProgressStore } from '@/lib/services/analysis/v2-progress-store';
import { demoResponseHeaders, isDemoOperator, projectDemoProgress } from '@/lib/services/demo-analysis/demo-analysis';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';
import { loadDemoFixtureForVersion } from '@/lib/services/demo-analysis/fixture-store';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
} from '@/lib/services/identity/account-principal-store';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';

const requestIdSchema = z.string().uuid();
const sequenceSchema = z.string().regex(/^\d{1,16}$/).transform(Number)
    .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const limitSchema = z.string().regex(/^\d{1,3}$/).transform(Number)
    .pipe(z.number().int().min(1).max(200));

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

export async function GET(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
    let demoRecognized = false;
    try {
        const requestId = requestIdSchema.safeParse((await params).requestId);
        if (!requestId.success) {
            return json({ error: 'Invalid progress request.' }, 400);
        }
        const url = new URL(request.url);

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

        const afterSequence = url.searchParams.has('afterSeq')
            ? sequenceSchema.safeParse(url.searchParams.get('afterSeq'))
            : { success: true as const, data: 0 };
        const eventLimit = url.searchParams.has('limit')
            ? limitSchema.safeParse(url.searchParams.get('limit'))
            : { success: true as const, data: 100 };
        if (!afterSequence.success || !eventLimit.success) {
            return demoRecognized
                ? demoJson({ error: 'Invalid progress request.' }, 400)
                : json({ error: 'Invalid progress request.' }, 400);
        }

        if (demo) {
            if (demo.user_id !== user.id || !isDemoOperator(user.id) || !demo.started_at) return demoJson({ error: 'Analysis progress not found.' }, 404);
            const fixture = await loadDemoFixtureForVersion(demo.fixture_version);
            if (!fixture) return demoJson({ error: 'Demo fixture is unavailable.' }, 503);
            const progress = projectDemoProgress({
                requestId: demo.id,
                fixtureVersion: demo.fixture_version,
                startedAt: new Date(demo.started_at),
                durationSeconds: demo.duration_seconds,
                now: new Date(),
                afterSequence: afterSequence.data,
                eventLimit: eventLimit.data,
                fixture: fixture.fixture,
            });
            return demoJson({ schemaVersion: ANALYSIS_V2_SCHEMA_VERSION, ...progress }, 200);
        }

        const progress = await analysisV2ProgressStore.loadForOwner({
            requestId: requestId.data,
            userId: user.id,
            afterSequence: afterSequence.data,
            eventLimit: eventLimit.data,
        });
        if (!progress) {
            return json({ error: 'Analysis progress not found.' }, 404);
        }

        const publicationAuthorized = progress.snapshot.status !== 'completed'
            || await isAnalysisResultAuthoritativelyPublished(requestId.data);
        const pendingProgress = !publicationAuthorized && progress.snapshot.status === 'completed'
            ? {
                ...progress,
                snapshot: {
                    ...progress.snapshot,
                    status: 'queued' as const,
                    progressBp: 0,
                    backgroundProcessing: true,
                    tracks: {
                        relationshipAi: {
                            state: 'pending' as const,
                            stageCode: 'PENDING',
                            done: 0,
                            total: 0,
                            progressBp: 0,
                        },
                        interactions: {
                            state: 'pending' as const,
                            stageCode: 'PENDING',
                            done: 0,
                            total: 0,
                            progressBp: 0,
                        },
                        finalization: {
                            state: 'pending' as const,
                            stageCode: 'PENDING',
                            done: 0,
                            total: 0,
                            progressBp: 0,
                        },
                    },
                    activeProfile: null,
                    etaRange: null,
                },
                events: [],
            }
            : progress;
        const response = progressReadV1Schema.parse({
            schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
            ...pendingProgress,
        });
        return json(response, 200);
    } catch {
        console.error('[analysis-v2-progress] owner progress read failed');
        return demoRecognized
            ? demoJson({ error: 'Progress could not be loaded.' }, 500)
            : json({ error: 'Progress could not be loaded.' }, 500);
    }
}
