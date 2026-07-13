import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { after, NextResponse } from 'next/server';
import {
    getInstagramProfile,
    getFollowers,
    getFollowing,
    extractMutualFollows,
    classifyByPrivacy,
    getProfilesBatch,
} from '@/lib/services/instagram/scraper';
import {
    analyzeCombined,
    getCachedCombinedProfileSnapshots,
} from '@/lib/services/ai/combined-analysis';
import {
    analyzeDeepRiskNarrative,
    parseDeepRiskNarrativeForInput,
    type DeepRiskNarrativeInput,
} from '@/lib/services/ai/deep-risk-analysis';
import {
    analyzePrivateAccountNames,
    createPrivateNameBatchResponseSchema,
    PRIVATE_NAME_BATCH_SIZE,
    type PrivateNameAnalysisResult,
} from '@/lib/services/ai/private-name-analysis';
import {
    getVertexAIAnalysisConcurrency,
} from '@/lib/services/ai/pipeline-config';
import {
    isAmbiguousGeminiGenerationError,
    isRecoverableGeminiResponseError,
} from '@/lib/services/ai/gemini-generation-policy';
import {
    getProfileCacheMissUsernames,
    mergeCachedAndScrapedProfiles,
} from '@/lib/services/analysis/profile-cache';
import {
    requireInsertedMutationRows,
    requireSingleMutationRow,
} from '@/lib/services/analysis/persistence';
import {
    getPhotogenicScore,
    getExposureScore,
    classifyGenderStatus,
    classifyRiskGrade,
    getHighRiskCount,
    TAG_SCORE,
} from '@/lib/constants/scoring';
import { sendAnalysisCompleteEmail } from '@/lib/services/email';
import type { AnalyzedAccount } from '@/lib/types/analysis';
import { createSupabaseScraperTelemetryHook } from '@/lib/services/instagram/supabase-telemetry';
import { parseScraperProviderSelection } from '@/lib/services/instagram/config';
import { expectedRelationshipCount } from '@/lib/services/instagram/completeness';
import {
    apifyInteractionAdapter,
    type ApifyPostComment,
    type ApifyPostLiker,
} from '@/lib/services/instagram/providers/apify-interactions';
import type {
    Capability,
    ScrapeRequestOptions,
    ScraperProviderSelection,
    ScraperTelemetryHook,
} from '@/lib/services/instagram/providers/types';
import {
    type AnalysisStep,
    type StepData,
    BATCH_SIZE,
    PROFILE_BATCH_SIZE,
    calculateBatchProgress,
    compactCompletedStepData,
    getPendingAnalysisSubBatches,
    resolveProfileProviderBatchUsernames,
} from '@/lib/services/analysis/steps';
import {
    ANALYSIS_STEP_LEASE_SECONDS,
    acquireAnalysisRequestLease,
    isAnalysisRequestOwner,
    releaseAnalysisRequestLease,
} from '@/lib/services/analysis/request-lease';
import { hasValidAnalysisRequestIdempotencyKey } from '@/lib/services/analysis/request-eligibility';
import {
    capPublicProfiles,
    getRelationshipScrapeLimit,
} from '@/lib/services/analysis/plan-limits';
import {
    CANDIDATE_INTERACTION_BATCH_SIZE,
    CANDIDATE_INTERACTION_POST_LIMIT,
    CANDIDATE_LIKER_LIMIT_PER_POST,
    extractCandidateInteractions,
    extractTargetInteractions,
    parseStoredInteractionCoverage,
    rankObservedInteractionCandidates,
    scoreCandidateInteractions,
    TARGET_COMMENT_LIMIT_PER_POST,
    TARGET_COMMENT_POST_LIMIT,
    TARGET_INTERACTION_POST_LIMIT,
    TARGET_LIKER_LIMIT_PER_POST,
    TARGET_LIKER_POST_LIMIT,
    type CandidateAccountPosts,
    type InteractionEvidenceRow,
    type StoredInteractionCoverage,
} from '@/lib/services/analysis/interaction-stage';
import {
    instagramPostUrl,
    selectRecentInteractionPosts,
} from '@/lib/services/analysis/interaction-posts';
import type { InstagramPost } from '@/lib/types/instagram';
import type { ProviderUsageDelta } from '@/lib/services/instagram/providers/types';
import { readBoundedDatabasePages } from '@/lib/services/analysis/paginated-query';
import {
    getRecentMutualBonus,
    inferRecentMutualFemaleRanks,
    orderedMutualUsernamesFromStepData,
} from '@/lib/services/analysis/recent-mutuals';
import {
    enqueueAnalysisTask,
    verifyAnalysisTaskAuthorization,
} from '@/lib/services/analysis/background-tasks';
import {
    buildSafeFallbackRiskNarrative,
    parseSafePublicRiskNarrative,
} from '@/lib/services/analysis/narrative-privacy';
import { completeAnalysisRequest } from '@/lib/services/analysis/completion';
import { parseRelationshipCheckpoint } from '@/lib/services/analysis/relationship-checkpoint';
import { checkpointRelationshipList } from '@/lib/services/analysis/relationship-persistence';
import {
    isRetryablePipelineError,
    MAX_CLOUD_TASK_PIPELINE_RETRIES,
    shouldAbortPipelineBeforeExecution,
    trustedCloudTasksRetryCount,
} from '@/lib/services/analysis/pipeline-retry';
import {
    requireCompletedInteractionJob,
    requireNoIncompleteInteractionJobs,
} from '@/lib/services/analysis/interaction-job-state';
import {
    analysisProviderRunCheckpoint,
    abortRunningAnalysisProviderRuns,
    clearAnalysisProviderRun,
    getAnalysisProviderRun,
} from '@/lib/services/analysis/provider-run';
import type { ProviderRunCheckpoint } from '@/lib/services/instagram/providers/types';
import { failAnalysisRequest } from '@/lib/services/analysis/failure';
import {
    analysisSemanticRetryStateKey,
    incrementAnalysisSemanticRetry,
} from '@/lib/services/analysis/semantic-retry';
import {
    beginGeminiGeneration,
    clearGeminiGeneration,
    rejectUnresolvedGeminiGeneration,
} from '@/lib/services/analysis/gemini-generation-intent';
import {
    classifyAnalysisFailure,
    recordAnalysisStepEvent,
} from '@/lib/services/analysis/observability';
import { recordGeminiUsageExpectation } from '@/lib/services/analysis/gemini-usage-expectation';
import { reconcileSettledAnalysisProviderCosts } from '@/lib/services/analysis/provider-cost-reconciliation';

const MAX_INTERACTION_EVIDENCE_ROWS = 2_500;
const PROVIDER_COST_RECONCILIATION_DELAY_MS = 35_000;
const PROVIDER_COST_RECONCILIATION_RETRIES = 3;

export const maxDuration = 300;

// 단계별 분석 처리 API
export async function POST(request: Request) {
    try {
        const isBackgroundTask = await verifyAnalysisTaskAuthorization(
            request.headers.get('authorization')
        );
        let userId: string | null = null;
        if (!isBackgroundTask) {
            const supabase = await createClient();
            const { data: { user }, error: authError } = await supabase.auth.getUser();
            if (authError || !user) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            userId = user.id;
        }

        const { requestId } = await request.json();

        if (!requestId) {
            return NextResponse.json({ error: 'requestId required' }, { status: 400 });
        }

        // 분석 요청 조회
        const { data: analysisRequest, error: fetchError } = await supabaseAdmin
            .from('analysis_requests')
            .select('*, users(email)')
            .eq('id', requestId)
            .single();

        if (fetchError && fetchError.code !== 'PGRST116') {
            throw new Error('ANALYSIS_PERSISTENCE_ERROR: request state read failed.');
        }
        if (!analysisRequest) {
            if (isBackgroundTask) {
                const globalCosts = await reconcileSettledAnalysisProviderCosts(supabaseAdmin);
                if (globalCosts.failed > 0 || globalCosts.hasMore) {
                    return NextResponse.json(
                        { error: 'Provider cost reconciliation is not settled yet.' },
                        { status: 503 }
                    );
                }
                return NextResponse.json({ success: true, done: true });
            }
            return NextResponse.json({ error: 'Request not found' }, { status: 404 });
        }
        if (!isBackgroundTask && !isAnalysisRequestOwner(userId ?? '', analysisRequest.user_id)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        if (
            analysisRequest.pipeline_version !== null
            && analysisRequest.pipeline_version !== undefined
            && analysisRequest.pipeline_version !== 'v1'
        ) {
            return NextResponse.json(
                {
                    error: 'This request requires the V2 background dispatcher.',
                    code: 'V2_PIPELINE_REQUIRED',
                },
                { status: 409 }
            );
        }

        // 이미 완료되었거나 실패한 경우
        if (analysisRequest.status === 'completed' || analysisRequest.status === 'failed') {
            const requestCosts = await reconcileSettledAnalysisProviderCosts(
                supabaseAdmin,
                requestId
            );
            const globalCosts = await reconcileSettledAnalysisProviderCosts(supabaseAdmin);
            if (globalCosts.failed > 0 || globalCosts.hasMore) {
                console.warn('Global provider cost reconciliation remains pending', {
                    eligible: globalCosts.eligible,
                    failed: globalCosts.failed,
                    hasMore: globalCosts.hasMore,
                });
            }
            if (isBackgroundTask && (requestCosts.failed > 0 || requestCosts.hasMore || globalCosts.hasMore)) {
                return NextResponse.json(
                    { error: 'Provider cost reconciliation is not settled yet.' },
                    { status: 503 }
                );
            }
            return NextResponse.json({
                success: true,
                step: analysisRequest.current_step,
                status: analysisRequest.status,
                done: true,
            });
        }
        if (!hasValidAnalysisRequestIdempotencyKey(analysisRequest)) {
            return NextResponse.json(
                { error: 'Legacy analysis request cannot execute paid steps.' },
                { status: 403 }
            );
        }

        let currentStep = (analysisRequest.current_step || 'pending') as AnalysisStep;
        const scraperTelemetry = createSupabaseScraperTelemetryHook();

        const lease = await acquireAnalysisRequestLease(
            supabaseAdmin,
            {
                requestId,
                userId: analysisRequest.user_id,
                expectedStep: currentStep,
                leaseSeconds: ANALYSIS_STEP_LEASE_SECONDS,
            }
        );
        if (!lease) {
            if (isBackgroundTask) {
                return NextResponse.json({
                    success: true,
                    step: currentStep,
                    done: false,
                    skipped: true,
                });
            }
            return NextResponse.json(
                { error: 'Analysis step is already processing or has advanced.' },
                { status: 409 }
            );
        }

        let stepSucceeded = false;
        let stepTerminalized = false;
        let leasedStepData: StepData = {};
        let deliveryAttempt: number | null = null;
        let stepProgress = Number(analysisRequest.progress ?? 0);
        const stepStartedAt = Date.now();
        try {
            // The lease CASes the broad step name. Batch cursors can advance while a
            // delayed worker waits for that lease, so execution state is read again
            // only after this worker owns the lease.
            const { data: leasedAnalysisRequest, error: leasedFetchError } = await supabaseAdmin
                .from('analysis_requests')
                .select('*, users(email)')
                .eq('id', requestId)
                .single();
            if (leasedFetchError || !leasedAnalysisRequest) {
                throw new Error('ANALYSIS_PERSISTENCE_ERROR: leased request state read failed.');
            }
            if (leasedAnalysisRequest.status === 'completed' || leasedAnalysisRequest.status === 'failed') {
                stepSucceeded = true;
                return NextResponse.json({
                    success: true,
                    step: leasedAnalysisRequest.current_step,
                    status: leasedAnalysisRequest.status,
                    done: true,
                });
            }

            currentStep = (leasedAnalysisRequest.current_step || 'pending') as AnalysisStep;
            const stepData: StepData = leasedAnalysisRequest.step_data || {};
            leasedStepData = stepData;
            stepProgress = Number(leasedAnalysisRequest.progress ?? stepProgress);
            const scraperOptions = parseScraperProviderSelection(stepData.scraperOptions);
            const targetId = leasedAnalysisRequest.target_instagram_id;
            const scrapeLimit = getRelationshipScrapeLimit(leasedAnalysisRequest.plan_type);
            const deliveryRetryCount = trustedCloudTasksRetryCount(
                request.headers,
                isBackgroundTask
            );
            deliveryAttempt = deliveryRetryCount === null ? null : deliveryRetryCount + 1;
            if (shouldAbortPipelineBeforeExecution(deliveryRetryCount)) {
                await abortPaidProviderRunsBeforeFailure(
                    requestId,
                    leasedAnalysisRequest.user_id
                );
                const failed = await failAnalysisRequest(supabaseAdmin, {
                    requestId,
                    userId: leasedAnalysisRequest.user_id,
                    expectedStep: currentStep,
                    errorMessage: '분석 작업 재시도 한도를 초과했습니다. 새 분석을 시작해주세요.',
                    compactStepData: {},
                });
                if (!failed) {
                    return NextResponse.json(
                        { error: 'Analysis state advanced while stopping exhausted work.' },
                        { status: 409 }
                    );
                }
                await recordAnalysisStepEvent(supabaseAdmin, {
                    requestId,
                    step: currentStep,
                    eventType: 'aborted',
                    deliveryAttempt,
                    progress: stepProgress,
                    latencyMs: Date.now() - stepStartedAt,
                    failureCategory: 'retry_exhausted',
                });
                stepTerminalized = true;
                return NextResponse.json({
                    success: false,
                    step: 'failed',
                    status: 'failed',
                    done: true,
                });
            }

            await recordAnalysisStepEvent(supabaseAdmin, {
                requestId,
                step: currentStep,
                eventType: 'started',
                deliveryAttempt,
                progress: stepProgress,
            });

            // 현재 단계에 따라 처리
            const stepResponse = await (async () => {
                switch (currentStep) {
                case 'pending':
                    // collect 단계로 전환
                    await updateStep(requestId, 'collect', stepData, 5, '분석 시작...');
                    return NextResponse.json({
                        success: true,
                        step: 'collect',
                        done: false,
                    });

                case 'collect':
                    return await processCollect(
                        requestId,
                        leasedAnalysisRequest.user_id,
                        targetId,
                        scrapeLimit,
                        stepData,
                        scraperOptions,
                        scraperTelemetry
                    );

                case 'profiles':
                    return await processProfiles(
                        requestId,
                        leasedAnalysisRequest.user_id,
                        targetId,
                        stepData,
                        scraperOptions,
                        scraperTelemetry
                    );

                case 'analyze':
                    return await processAnalyze(
                        requestId,
                        leasedAnalysisRequest.user_id,
                        stepData
                    );

                case 'interactions':
                    return await processInteractions(
                        requestId,
                        leasedAnalysisRequest.user_id,
                        targetId,
                        stepData
                    );

                case 'deep_analysis':
                    return await processDeepAnalysis(
                        requestId,
                        leasedAnalysisRequest.user_id,
                        targetId,
                        stepData
                    );

                case 'finalize':
                    return await processFinalize(requestId, leasedAnalysisRequest, stepData);

                // 레거시 단계 처리 (하위 호환성 - analyze로 리다이렉트)
                case 'gender':
                case 'features':
                    await updateStep(requestId, 'analyze', { ...stepData, analyzeBatchIndex: 0, combinedResults: {} }, 50, 'AI 분석 준비 중...');
                    return NextResponse.json({
                        success: true,
                        step: 'analyze',
                        done: false,
                    });

                default:
                    return NextResponse.json({
                        success: true,
                        step: currentStep,
                        done: true,
                    });
                }
            })();
            stepSucceeded = stepResponse.ok;
            await recordAnalysisStepEvent(supabaseAdmin, {
                requestId,
                step: currentStep,
                eventType: stepResponse.ok ? 'completed' : 'failed',
                deliveryAttempt,
                progress: stepProgress,
                latencyMs: Date.now() - stepStartedAt,
                failureCategory: stepResponse.ok ? null : 'unknown',
            });
            return stepResponse;
        } catch (pipelineError) {
            const errorMessage = pipelineError instanceof Error ? pipelineError.message : 'Unknown error';
            console.error('Analysis step failed', { requestId, currentStep });

            if (
                isRetryablePipelineError(pipelineError)
                && currentStep !== 'completed'
                && currentStep !== 'failed'
            ) {
                const semanticRetryCount = await incrementAnalysisSemanticRetry(
                    supabaseAdmin,
                    {
                        requestId,
                        userId: analysisRequest.user_id,
                        expectedStep: currentStep,
                        stateKey: analysisSemanticRetryStateKey(currentStep, leasedStepData),
                    }
                );
                if (semanticRetryCount === null) {
                    await recordAnalysisStepEvent(supabaseAdmin, {
                        requestId,
                        step: currentStep,
                        eventType: 'skipped',
                        deliveryAttempt,
                        progress: stepProgress,
                        latencyMs: Date.now() - stepStartedAt,
                    });
                    return NextResponse.json(
                        { error: 'Analysis state advanced before retry was recorded.' },
                        { status: 409 }
                    );
                }
                if (semanticRetryCount <= MAX_CLOUD_TASK_PIPELINE_RETRIES) {
                    await recordAnalysisStepEvent(supabaseAdmin, {
                        requestId,
                        step: currentStep,
                        eventType: 'retrying',
                        deliveryAttempt,
                        progress: stepProgress,
                        latencyMs: Date.now() - stepStartedAt,
                        failureCategory: classifyAnalysisFailure(pipelineError),
                    });
                    return NextResponse.json(
                        {
                            error: errorMessage,
                            step: currentStep,
                            retrying: true,
                            retryCount: semanticRetryCount,
                        },
                        { status: 503 }
                    );
                }
            }

            await abortPaidProviderRunsBeforeFailure(
                requestId,
                analysisRequest.user_id
            );
            const failed = await failAnalysisRequest(supabaseAdmin, {
                requestId,
                userId: analysisRequest.user_id,
                expectedStep: currentStep,
                errorMessage,
                compactStepData: {},
            });
            if (!failed) {
                return NextResponse.json(
                    { error: 'Analysis state advanced before failure was recorded.' },
                    { status: 409 }
                );
            }

            await recordAnalysisStepEvent(supabaseAdmin, {
                requestId,
                step: currentStep,
                eventType: 'failed',
                deliveryAttempt,
                progress: stepProgress,
                latencyMs: Date.now() - stepStartedAt,
                failureCategory: classifyAnalysisFailure(pipelineError),
            });
            stepTerminalized = true;

            return NextResponse.json({ error: errorMessage, step: currentStep }, { status: 500 });
        } finally {
            await releaseAnalysisRequestLease(supabaseAdmin, lease);
            if (isBackgroundTask && (stepSucceeded || stepTerminalized)) {
                await enqueueBackgroundContinuation(requestId);
            } else if (
                !isBackgroundTask
                && (stepTerminalized || (stepSucceeded && currentStep === 'finalize'))
            ) {
                scheduleBrowserFallbackCostReconciliation(requestId);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Step failed';
        console.error('Analysis step API failed');
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}

export function scheduleBrowserFallbackCostReconciliation(requestId: string): void {
    after(async () => {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, PROVIDER_COST_RECONCILIATION_DELAY_MS);
        });
        for (let attempt = 0; attempt < PROVIDER_COST_RECONCILIATION_RETRIES; attempt++) {
            const result = await reconcileSettledAnalysisProviderCosts(
                supabaseAdmin,
                requestId
            );
            if (result.failed === 0 && !result.hasMore) return;
            if (attempt + 1 < PROVIDER_COST_RECONCILIATION_RETRIES) {
                await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
            }
        }
        console.warn('Browser fallback provider cost reconciliation remains pending');
    });
}

async function abortPaidProviderRunsBeforeFailure(
    requestId: string,
    userId: string
): Promise<void> {
    await abortRunningAnalysisProviderRuns(supabaseAdmin, {
        requestId,
        userId,
    });
}

async function enqueueBackgroundContinuation(requestId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
        .from('analysis_requests')
        .select('status, current_step, progress, step_data, background_processing')
        .eq('id', requestId)
        .maybeSingle();
    if (error || !data) {
        throw new Error('ANALYSIS_TASKS_ENQUEUE_ERROR: continuation state read failed.');
    }
    if (!['pending', 'processing'].includes(data.status)) {
        await enqueueAnalysisTask(requestId, {
            currentStep: data.current_step || data.status,
            progress: Number(data.progress ?? 100),
            stepData: (data.step_data ?? {}) as StepData,
        }, { delaySeconds: 35 });
        if (data.background_processing === true) {
            await setBackgroundProcessing(requestId, false);
        }
        return;
    }

    try {
        const outcome = await enqueueAnalysisTask(requestId, {
            currentStep: data.current_step || 'pending',
            progress: Number(data.progress ?? 0),
            stepData: (data.step_data ?? {}) as StepData,
        });
        if (outcome === 'disabled') {
            throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: background continuation is disabled.');
        }
        if (data.background_processing !== true) {
            await setBackgroundProcessing(requestId, true);
        }
    } catch (error) {
        // Let the authenticated progress page resume while Cloud Tasks performs its own retry.
        // The request lease keeps the two drivers from charging the same step concurrently.
        await setBackgroundProcessing(requestId, false);
        throw error;
    }
}

async function setBackgroundProcessing(requestId: string, active: boolean): Promise<void> {
    const mutation = await supabaseAdmin
        .from('analysis_requests')
        .update({ background_processing: active })
        .eq('id', requestId)
        .select('id')
        .maybeSingle();
    requireSingleMutationRow(mutation, 'background processing state update');
}

function providerOptions(
    selection: ScraperProviderSelection,
    capability: Capability,
    requestId: string,
    onTelemetry: ScraperTelemetryHook,
    expectedResultCount?: number,
    providerRun?: ProviderRunCheckpoint
): ScrapeRequestOptions {
    return {
        provider: selection[capability],
        fallback: selection.fallback,
        requestId,
        onTelemetry,
        expectedResultCount,
        providerRun,
    };
}

// 상태 업데이트 헬퍼
async function updateStep(
    requestId: string,
    step: AnalysisStep,
    stepData: StepData,
    progress: number,
    progressStep: string
) {
    const mutation = await supabaseAdmin
        .from('analysis_requests')
        .update({
            status: 'processing',
            current_step: step,
            step_data: stepData,
            progress,
            progress_step: progressStep,
        })
        .eq('id', requestId)
        .select('id')
        .maybeSingle();
    requireSingleMutationRow(mutation, 'analysis step update');
}

// Step 1: 프로필 + 팔로워/팔로잉 수집 + 맞팔 추출
async function processCollect(
    requestId: string,
    userId: string,
    targetId: string,
    scrapeLimit: number,
    stepData: StepData,
    scraperOptions: ScraperProviderSelection,
    scraperTelemetry: ScraperTelemetryHook
) {
    rejectUnresolvedGeminiGeneration(stepData);
    let collectStepData = stepData;
    let profileCheckpoint = stepData.targetProfileCheckpoint;
    const targetProfileOperationKey = 'profile:target';

    // A paid fallback can be used even when the configured primary is self-hosted.
    // Persist the parsed profile before clearing its run ID so every crash boundary
    // has either a resumable Actor or a reusable database result.
    if (!profileCheckpoint) {
        await updateStep(requestId, 'collect', collectStepData, 5, '대상 계정 정보 수집 중...');
        const providerRun = await analysisProviderRunCheckpoint(supabaseAdmin, {
            requestId,
            userId,
            expectedStep: 'collect',
            operationKey: targetProfileOperationKey,
        });
        const profile = await getInstagramProfile(
            targetId,
            providerOptions(
                scraperOptions,
                'profile',
                requestId,
                scraperTelemetry,
                undefined,
                providerRun
            )
        );
        if (!profile) {
            throw new Error('계정을 찾을 수 없습니다.');
        }
        profileCheckpoint = {
            profilePicUrl: profile.profilePicUrl,
            followersCount: profile.followersCount,
            followingCount: profile.followingCount,
            isPrivate: profile.isPrivate,
            targetPosts: selectRecentInteractionPosts(
                profile.latestPosts ?? [],
                TARGET_INTERACTION_POST_LIMIT
            ).map(post => ({
                id: post.id,
                shortCode: post.shortCode,
                type: post.type,
                likesCount: Math.max(0, post.likesCount),
                commentsCount: Math.max(0, post.commentsCount),
                timestamp: post.timestamp,
            })),
        };
        collectStepData = { ...collectStepData, targetProfileCheckpoint: profileCheckpoint };
        await updateStep(
            requestId,
            'collect',
            collectStepData,
            10,
            '대상 계정 정보 저장 완료'
        );
    }
    await clearAnalysisProviderRun(supabaseAdmin, {
        requestId,
        operationKey: targetProfileOperationKey,
    });

    if (profileCheckpoint.isPrivate) {
        throw new Error('비공개 계정은 분석할 수 없습니다.');
    }

    // Persist both paid relationship results before name/profile work. A retry after this
    // checkpoint reuses the lists instead of starting the Actors again.
    await updateStep(requestId, 'collect', collectStepData, 15, '팔로워/팔로잉 목록 수집 중...');
    const existingCheckpoint = parseRelationshipCheckpoint(
        collectStepData.relationshipCheckpoint,
        scrapeLimit
    );
    const [followersProviderRun, followingProviderRun] = await Promise.all([
        analysisProviderRunCheckpoint(supabaseAdmin, {
            requestId,
            userId,
            expectedStep: 'collect',
            operationKey: 'relationship:followers',
        }),
        analysisProviderRunCheckpoint(supabaseAdmin, {
            requestId,
            userId,
            expectedStep: 'collect',
            operationKey: 'relationship:following',
        }),
    ]);
    const checkpointedFollowers = existingCheckpoint?.followers;
    const checkpointedFollowing = existingCheckpoint?.following;
    const followersPromise = checkpointedFollowers
        ? clearAnalysisProviderRun(supabaseAdmin, {
                requestId,
                operationKey: 'relationship:followers',
            }).then(() => checkpointedFollowers)
        : getFollowers(
                targetId,
                scrapeLimit,
                providerOptions(
                    scraperOptions,
                    'followers',
                    requestId,
                    scraperTelemetry,
                    expectedRelationshipCount(profileCheckpoint.followersCount, scrapeLimit),
                    followersProviderRun
                )
            ).then(async rows => {
                await checkpointRelationshipList(supabaseAdmin, {
                    requestId,
                    userId,
                    kind: 'followers',
                    rows,
                });
                await clearAnalysisProviderRun(supabaseAdmin, {
                    requestId,
                    operationKey: 'relationship:followers',
                });
                return rows;
            });
    const followingPromise = checkpointedFollowing
        ? clearAnalysisProviderRun(supabaseAdmin, {
                requestId,
                operationKey: 'relationship:following',
            }).then(() => checkpointedFollowing)
        : getFollowing(
                targetId,
                scrapeLimit,
                providerOptions(
                    scraperOptions,
                    'following',
                    requestId,
                    scraperTelemetry,
                    expectedRelationshipCount(profileCheckpoint.followingCount, scrapeLimit),
                    followingProviderRun
                )
            ).then(async rows => {
                await checkpointRelationshipList(supabaseAdmin, {
                    requestId,
                    userId,
                    kind: 'following',
                    rows,
                });
                await clearAnalysisProviderRun(supabaseAdmin, {
                    requestId,
                    operationKey: 'relationship:following',
                });
                return rows;
            });
    const [followersResult, followingResult] = await Promise.allSettled([
        followersPromise,
        followingPromise,
    ]);
    if (followersResult.status === 'rejected') throw followersResult.reason;
    if (followingResult.status === 'rejected') throw followingResult.reason;
    const followers = followersResult.value;
    const following = followingResult.value;
    const checkpointedStepData: StepData = {
        ...collectStepData,
        relationshipCheckpoint: { followers, following },
    };
    await updateStep(
        requestId,
        'collect',
        checkpointedStepData,
        22,
        '맞팔 계정 분류 준비 중...'
    );

    // 맞팔 추출
    await updateStep(requestId, 'collect', checkpointedStepData, 25, '맞팔 계정 분석 중...');
    const mutualFollows = extractMutualFollows(followers, following);

    // 공개/비공개 분류
    const { publicAccounts, privateAccounts } = classifyByPrivacy(mutualFollows);

    // 비공개 계정은 사진/게시물 없이 username과 표시 이름만 100개 단위로 분류한다.
    const privateNameInputs = privateAccounts.map(account => ({
        id: account.username,
        username: account.username,
        ...(account.fullName ? { fullName: account.fullName } : {}),
    }));
    const privateNameSchema = createPrivateNameBatchResponseSchema(
        privateNameInputs.map(account => account.id)
    );
    const storedPrivateNames = checkpointedStepData.privateNameResults === undefined
        ? null
        : privateNameSchema.safeParse(checkpointedStepData.privateNameResults);
    if (storedPrivateNames && !storedPrivateNames.success) {
        throw new Error('AI_GENERATION_CHECKPOINT_ERROR: private-name checkpoint is invalid.');
    }

    let privateNameResults: PrivateNameAnalysisResult[] = storedPrivateNames?.success
        ? storedPrivateNames.data
        : [];
    if (privateNameInputs.length > 0 && !storedPrivateNames) {
        const generationStepData = beginGeminiGeneration(checkpointedStepData, {
            kind: 'private_names',
            operationKey: 'private-names',
            inputIds: privateNameInputs.map(account => account.id),
        });
        await updateStep(
            requestId,
            'collect',
            generationStepData,
            25,
            '비공개 계정 이름 분류 중...'
        );
        await recordGeminiUsageExpectation(supabaseAdmin, {
            requestId,
            userId,
            expectedStep: 'collect',
            operationKey: 'private-names',
            generationKind: 'private_names',
            expectedRecordCount: Math.ceil(
                privateNameInputs.length / PRIVATE_NAME_BATCH_SIZE
            ),
        });
        try {
            privateNameResults = await analyzePrivateAccountNames(privateNameInputs, requestId);
        } catch {
            console.warn('Private account name analysis input failed; using neutral ordering', {
                requestId,
            });
            privateNameResults = privateAccounts.map(account => ({
                id: account.username,
                femaleScore: 0.5,
                isName: false,
                confidence: 0,
            }));
        }

        const privateNameCheckpoint = clearGeminiGeneration({
            ...generationStepData,
            privateNameResults,
        });
        try {
            await updateStep(
                requestId,
                'collect',
                privateNameCheckpoint,
                27,
                '비공개 계정 이름 분류 저장 완료'
            );
        } catch {
            throw new Error(
                'AI_RESULT_PERSISTENCE_ERROR: generated private-name results could not be checkpointed.'
            );
        }
    }
    const privateNameByUsername = new Map(
        privateNameResults.map(result => [normalizedUsername(result.id), result])
    );

    // 비공개 계정 저장
    if (privateAccounts.length > 0) {
        const inserted = await supabaseAdmin.from('private_accounts').upsert(
            privateAccounts.map((account) => {
                const nameAnalysis = privateNameByUsername.get(
                    normalizedUsername(account.username)
                );
                return {
                    request_id: requestId,
                    instagram_id: account.username,
                    profile_image: account.profilePicUrl,
                    full_name: account.fullName,
                    name_female_score: nameAnalysis?.femaleScore ?? 0.5,
                    name_is_name: nameAnalysis?.isName ?? false,
                    name_confidence: nameAnalysis?.confidence ?? 0,
                };
            }),
            { onConflict: 'request_id,instagram_id' }
        ).select('id');
        requireInsertedMutationRows(inserted, privateAccounts.length, 'private accounts insert');
    }

    // 통계 업데이트
    const collectStatsMutation = await supabaseAdmin
        .from('analysis_requests')
        .update({
            total_followers: followers.length,
            mutual_follows: mutualFollows.length,
        })
        .eq('id', requestId)
        .select('id')
        .maybeSingle();
    requireSingleMutationRow(collectStatsMutation, 'collection statistics update');

    // step_data 업데이트
    const newStepData: StepData = {
        scraperOptions: collectStepData.scraperOptions,
        mutualFollows: mutualFollows.map((m) => m.username),
        targetProfileImage: profileCheckpoint.profilePicUrl,
        targetPosts: profileCheckpoint.targetPosts,
        publicAccounts: capPublicProfiles(publicAccounts).map((a) => ({
            username: a.username,
            profilePicUrl: a.profilePicUrl,
            isPrivate: a.isPrivate,
        })),
    };

    // 다음 단계로 전환
    await updateStep(requestId, 'profiles', newStepData, 30, '공개 계정 프로필 수집 준비 중...');

    return NextResponse.json({
        success: true,
        step: 'profiles',
        done: false,
        stats: {
            totalFollowers: followers.length,
            mutualFollows: mutualFollows.length,
            publicAccounts: publicAccounts.length,
            privateAccounts: privateAccounts.length,
        },
    });
}

// Step 2: 공개 계정 프로필 배치 수집
async function processProfiles(
    requestId: string,
    userId: string,
    targetId: string,
    stepData: StepData,
    scraperOptions: ScraperProviderSelection,
    scraperTelemetry: ScraperTelemetryHook
) {
    const publicAccounts = stepData.publicAccounts || [];
    const batchIndex = stepData.profileBatchIndex || 0;
    const accountsWithPosts = stepData.accountsWithPosts || [];

    // If a prior invocation committed the batch cursor and then lost the cleanup
    // response, retire that already-persisted run before doing more paid work.
    if (batchIndex > 0) {
        await clearAnalysisProviderRun(supabaseAdmin, {
            requestId,
            operationKey: `profiles:${batchIndex - 1}`,
        });
    }

    if (publicAccounts.length === 0) {
        // 공개 계정이 없으면 바로 완료
        await updateStep(requestId, 'finalize', stepData, 97, '결과 저장 중...');
        return NextResponse.json({
            success: true,
            step: 'finalize',
            done: false,
        });
    }

    const totalBatches = Math.ceil(publicAccounts.length / PROFILE_BATCH_SIZE);

    // 모든 배치 완료 시 다음 단계로
    if (batchIndex >= totalBatches) {
        const newStepData: StepData = {
            ...stepData,
            analyzeBatchIndex: 0,
            combinedResults: {},
        };

        await updateStep(requestId, 'analyze', newStepData, 50, 'AI 분석 준비 중...');

        return NextResponse.json({
            success: true,
            step: 'analyze',
            done: false,
            stats: {
                profilesCollected: accountsWithPosts.length,
            },
        });
    }

    // 현재 배치 처리
    const startIdx = batchIndex * PROFILE_BATCH_SIZE;
    const endIdx = Math.min(startIdx + PROFILE_BATCH_SIZE, publicAccounts.length);
    const batch = publicAccounts.slice(startIdx, endIdx);

    const progress = 30 + Math.round((batchIndex / totalBatches) * 20); // 30~50%
    await updateStep(
        requestId,
        'profiles',
        stepData,
        progress,
        `프로필 수집 중... (${batchIndex + 1}/${totalBatches})`
    );

    // Current-version cache snapshots can skip the profile provider for up to the bounded TTL.
    // Cache/query failures return no snapshots, so the existing provider path remains the fallback.
    const cachedSnapshots = new Map(await getCachedCombinedProfileSnapshots(
        batch.map(account => account.username)
    ));
    const frozenInput = stepData.profileProviderBatchCheckpoint;
    const missingUsernames = resolveProfileProviderBatchUsernames(
        frozenInput,
        batchIndex,
        batch.map(account => account.username),
        getProfileCacheMissUsernames(batch, cachedSnapshots)
    );
    let profilesStepData = stepData;
    if (frozenInput) {
        // The provider result owns these usernames for this operation even if another
        // request populated the shared cache while the Actor was running.
        for (const username of frozenInput.usernames) {
            cachedSnapshots.delete(normalizedUsername(username));
        }
    } else if (missingUsernames.length > 0) {
        profilesStepData = {
            ...stepData,
            profileProviderBatchCheckpoint: {
                batchIndex,
                usernames: [...missingUsernames],
            },
        };
        await updateStep(
            requestId,
            'profiles',
            profilesStepData,
            progress,
            `프로필 수집 입력 확정 중... (${batchIndex + 1}/${totalBatches})`
        );
    }
    const providerRun = missingUsernames.length > 0
        ? await analysisProviderRunCheckpoint(supabaseAdmin, {
            requestId,
            userId,
            expectedStep: 'profiles',
            operationKey: `profiles:${batchIndex}`,
        })
        : undefined;
    const profiles = missingUsernames.length > 0
        ? await getProfilesBatch(
            missingUsernames,
            missingUsernames.length,
            providerOptions(
                scraperOptions,
                'profilesBatch',
                requestId,
                scraperTelemetry,
                undefined,
                providerRun
            )
        )
        : [];

    const batchAccountsWithPosts = mergeCachedAndScrapedProfiles(
        batch,
        cachedSnapshots,
        profiles,
        { allowUnavailable: true }
    );

    // 기존 결과에 추가
    const updatedAccountsWithPosts = [...accountsWithPosts, ...batchAccountsWithPosts];

    const persistedStepData = { ...profilesStepData };
    delete persistedStepData.profileProviderBatchCheckpoint;
    const newStepData: StepData = {
        ...persistedStepData,
        accountsWithPosts: updatedAccountsWithPosts,
        profileBatchIndex: batchIndex + 1,
    };

    const newProgress = 30 + Math.round(((batchIndex + 1) / totalBatches) * 20);
    await updateStep(
        requestId,
        'profiles',
        newStepData,
        newProgress,
        `프로필 수집 중... (${batchIndex + 1}/${totalBatches})`
    );
    if (providerRun) {
        await clearAnalysisProviderRun(supabaseAdmin, {
            requestId,
            operationKey: `profiles:${batchIndex}`,
        });
    }

    return NextResponse.json({
        success: true,
        step: 'profiles',
        done: false,
        batchProgress: {
            current: batchIndex + 1,
            total: totalBatches,
        },
    });
}

// Step 3: 통합 분석 (성별 + 여성인 경우 외모/노출) + 캐싱 + 토큰 추적
async function processAnalyze(requestId: string, userId: string, stepData: StepData) {
    rejectUnresolvedGeminiGeneration(stepData);
    const accountsWithPosts = stepData.accountsWithPosts || [];
    const batchIndex = stepData.analyzeBatchIndex || 0;
    const combinedResults = stepData.combinedResults || {};

    const totalBatches = Math.ceil(accountsWithPosts.length / BATCH_SIZE);

    if (batchIndex >= totalBatches) {
        if (accountsWithPosts.some(account => (
            !combinedResults[account.profile.username]
        ))) {
            throw new Error(
                'AI_ANALYSIS_INCOMPLETE_ERROR: classification checkpoint is incomplete.'
            );
        }
        // 모든 배치 완료 - 통계 계산 후 finalize 단계로
        const genderStats = { male: 0, female: 0, unknown: 0 };
        let femaleCount = 0;

        for (const account of accountsWithPosts) {
            const result = combinedResults[account.profile.username];
            if (!result) continue;

            if (result.gender === 'male') genderStats.male++;
            else if (result.gender === 'female') {
                genderStats.female++;
                const { include } = classifyGenderStatus(result.gender, result.genderConfidence);
                if (include) femaleCount++;
            }
            else genderStats.unknown++;
        }

        const genderStatsMutation = await supabaseAdmin
            .from('analysis_requests')
            .update({
                opposite_gender_count: femaleCount,
                gender_stats: genderStats,
            })
            .eq('id', requestId)
            .select('id')
            .maybeSingle();
        requireSingleMutationRow(genderStatsMutation, 'gender statistics update');

        const newStepData: StepData = {
            ...stepData,
            combinedResults,
            interactionStage: 'target',
            interactionCandidateBatchIndex: 0,
        };

        await updateStep(requestId, 'interactions', newStepData, 82, '상호작용 수집 준비 중...');

        return NextResponse.json({
            success: true,
            step: 'interactions',
            done: false,
            stats: {
                genderStats,
                femaleCount,
            },
        });
    }

    // 현재 배치 처리
    const startIdx = batchIndex * BATCH_SIZE;
    const endIdx = Math.min(startIdx + BATCH_SIZE, accountsWithPosts.length);
    const batch = accountsWithPosts.slice(startIdx, endIdx);

    const progress = calculateBatchProgress('analyze', batchIndex, totalBatches);
    await updateStep(
        requestId,
        'analyze',
        stepData,
        progress,
        `AI 분석 중... (${batchIndex + 1}/${totalBatches})`
    );

    // 품질 모드의 이미지 디코딩 부하를 고려해 기본 5, 환경 변수로 최대 10까지 조절
    const subBatchSize = getVertexAIAnalysisConcurrency();
    const pendingSubBatches = getPendingAnalysisSubBatches(
        batch,
        subBatchSize,
        account => Object.prototype.hasOwnProperty.call(
            combinedResults,
            account.profile.username
        )
    );
    for (const { operationIndex, items: subBatch } of pendingSubBatches) {
        const generationStepData = beginGeminiGeneration(
            { ...stepData, combinedResults: { ...combinedResults } },
            {
                kind: 'combined',
                operationKey: `combined:${batchIndex}:${operationIndex}`,
                inputIds: subBatch.map(account => account.profile.username),
            }
        );
        await updateStep(
            requestId,
            'analyze',
            generationStepData,
            progress,
            `AI 분석 중... (${batchIndex + 1}/${totalBatches})`
        );
        await recordGeminiUsageExpectation(supabaseAdmin, {
            requestId,
            userId,
            expectedStep: 'analyze',
            operationKey: `combined:${batchIndex}:${operationIndex}`,
            generationKind: 'combined',
            expectedRecordCount: subBatch.length,
        });
        const outcomes = await Promise.allSettled(
            subBatch.map(account => analyzeCombined({
                profile: account.profile as Parameters<typeof analyzeCombined>[0]['profile'],
                recentPosts: account.recentPosts as Parameters<typeof analyzeCombined>[0]['recentPosts'],
                refreshCacheSnapshot: account.profileSource === 'provider',
                requestId,
            }))
        );

        let ambiguousGenerationError: unknown;
        let accountFailure: unknown;
        let accountFailed = false;
        for (let resultIndex = 0; resultIndex < outcomes.length; resultIndex++) {
            const outcome = outcomes[resultIndex];
            const account = subBatch[resultIndex];
            if (!account || !outcome) continue;
            if (outcome.status === 'rejected') {
                console.error('Combined analysis failed for one account', { requestId });
                if (isAmbiguousGeminiGenerationError(outcome.reason)) {
                    accountFailed = true;
                    ambiguousGenerationError ??= outcome.reason;
                } else if (isRecoverableGeminiResponseError(outcome.reason)) {
                    combinedResults[account.profile.username] = {
                        gender: 'unknown',
                        genderConfidence: 0,
                    };
                } else {
                    accountFailed = true;
                    accountFailure ??= outcome.reason;
                }
                continue;
            }

            const username = account.profile.username;
            const result = outcome.value;
            combinedResults[username] = {
                gender: result.gender,
                genderConfidence: result.genderConfidence,
                photogenicGrade: result.photogenicGrade,
                photogenicConfidence: result.photogenicConfidence,
                skinVisibility: result.skinVisibility,
                exposureConfidence: result.exposureConfidence,
                ownerIdentified: result.ownerIdentified,
                isMarried: result.isMarried,
                marriedConfidence: result.marriedConfidence,
                isForeigner: result.isForeigner,
                foreignerConfidence: result.foreignerConfidence,
            };
        }

        let checkpointError: unknown;
        try {
            await updateStep(
                requestId,
                'analyze',
                clearGeminiGeneration({ ...stepData, combinedResults }),
                progress,
                `AI 분석 중... (${batchIndex + 1}/${totalBatches})`
            );
        } catch (error) {
            checkpointError = error;
        }

        // An ambiguous generation is terminal. A checkpoint failure after this
        // sub-batch may also follow a charged success, so fail closed instead of
        // classifying it as transient and replaying the generation.
        if (ambiguousGenerationError) throw ambiguousGenerationError;
        if (checkpointError) {
            throw new Error(
                'AI_RESULT_PERSISTENCE_ERROR: generated classification results could not be checkpointed.'
            );
        }
        if (accountFailed) {
            throw accountFailure instanceof Error
                ? accountFailure
                : new Error('AI_ANALYSIS_ERROR: account classification failed.');
        }
    }

    const newStepData: StepData = {
        ...stepData,
        combinedResults,
        analyzeBatchIndex: batchIndex + 1,
    };

    await updateStep(
        requestId,
        'analyze',
        newStepData,
        calculateBatchProgress('analyze', batchIndex + 1, totalBatches),
        `AI 분석 중... (${batchIndex + 1}/${totalBatches})`
    );

    return NextResponse.json({
        success: true,
        step: 'analyze',
        done: false,
        batchProgress: {
            current: batchIndex + 1,
            total: totalBatches,
        },
    });
}

interface InteractionUsage {
    estimatedCostUsd: number;
}

interface StoredInteractionJob {
    kind: 'target_likers' | 'target_comments' | 'candidate_likers';
    batch_index: number;
    status: 'running' | 'completed' | 'failed';
    coverage: unknown;
}

function interactionUsageContext(
    usage: InteractionUsage,
    providerRun: ProviderRunCheckpoint
) {
    return {
        ...(providerRun.resumeRunId ? { resumeRunId: providerRun.resumeRunId } : {}),
        ...(providerRun.logicalProvider
            ? { logicalProvider: providerRun.logicalProvider }
            : {}),
        ...(providerRun.actorId ? { actorId: providerRun.actorId } : {}),
        ...(providerRun.credentialSlot
            ? { credentialSlot: providerRun.credentialSlot }
            : {}),
        ...(providerRun.maxChargeUsd !== undefined
            ? { maxChargeUsd: providerRun.maxChargeUsd }
            : {}),
        ...(providerRun.startReserved ? { startReserved: true } : {}),
        ...(providerRun.onBeforeRunStart
            ? { onBeforeRunStart: providerRun.onBeforeRunStart }
            : {}),
        ...(providerRun.onRunStarted ? { onRunStarted: providerRun.onRunStarted } : {}),
        ...(providerRun.onCostRunStarted
            ? { onCostRunStarted: providerRun.onCostRunStarted }
            : {}),
        ...(providerRun.onCostRunFinished
            ? { onCostRunFinished: providerRun.onCostRunFinished }
            : {}),
        recordUsage(delta: ProviderUsageDelta) {
            usage.estimatedCostUsd += delta.estimated_cost_usd ?? 0;
        },
    };
}

function targetPostsFromStepData(stepData: StepData): InstagramPost[] {
    return (stepData.targetPosts ?? []).map(post => ({
        ...post,
        taggedUsers: [],
        mentionedUsers: [],
    }));
}

function candidatePostsFromStepData(
    account: NonNullable<StepData['accountsWithPosts']>[number]
): InstagramPost[] {
    return account.recentPosts.map(post => ({
        id: post.id,
        shortCode: post.shortCode,
        caption: post.caption,
        hashtags: post.hashtags ?? [],
        imageUrl: post.imageUrl,
        type: post.type,
        likesCount: Math.max(0, post.likesCount),
        commentsCount: Math.max(0, post.commentsCount),
        timestamp: post.timestamp,
        taggedUsers: post.taggedUsers ?? [],
        mentionedUsers: post.mentionedUsers ?? [],
    }));
}

function femaleInteractionAccounts(stepData: StepData) {
    const combinedResults = stepData.combinedResults ?? {};
    return (stepData.accountsWithPosts ?? []).filter(account => {
        const result = combinedResults[account.profile.username];
        if (!result) return false;
        return classifyGenderStatus(result.gender, result.genderConfidence).include;
    });
}

type FemaleInteractionAccount = ReturnType<typeof femaleInteractionAccounts>[number];

function normalizedUsername(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

function getCandidateIntermediateEvidence(
    targetId: string,
    stepData: StepData,
    account: FemaleInteractionAccount
) {
    const username = normalizedUsername(account.profile.username);
    const targetUsername = normalizedUsername(targetId);
    const combinedResult = stepData.combinedResults?.[account.profile.username];
    const isTagged = account.recentPosts.some(post =>
        [...(post.taggedUsers ?? []), ...(post.mentionedUsers ?? [])]
            .some(value => normalizedUsername(value) === targetUsername)
    );
    const photogenicGrade = combinedResult?.photogenicGrade ?? 1;
    const exposureLevel = combinedResult?.skinVisibility ?? 'low';
    const isMarried = combinedResult?.isMarried ?? false;
    const isForeigner = combinedResult?.isForeigner ?? false;
    const baseFeatureScore = isMarried || isForeigner
        ? 0
        : getPhotogenicScore(photogenicGrade)
            + getExposureScore(exposureLevel)
            + (isTagged ? TAG_SCORE : 0);
    const recencyBonus = getRecentMutualBonus(
        username,
        orderedMutualUsernamesFromStepData(stepData)
    );

    return {
        username,
        photogenicGrade,
        exposureLevel,
        ownerIdentified: combinedResult?.ownerIdentified,
        isTagged,
        isMarried,
        isForeigner,
        recencyBonus,
        intermediateScore: baseFeatureScore + recencyBonus,
    };
}

function interactionErrorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    const match = message.match(/(?:ANALYSIS|SCRAPING|INTERACTION)_[A-Z_]+/);
    return match?.[0]?.slice(0, 100) ?? 'INTERACTION_PROVIDER_ERROR';
}

function interactionOperationKey(
    kind: StoredInteractionJob['kind'],
    batchIndex: number
): string {
    return `interaction:${kind}:${batchIndex}`;
}

async function persistInteractionJob(input: {
    requestId: string;
    kind: StoredInteractionJob['kind'];
    batchIndex: number;
    postCount: number;
    requestedPerPost: number;
    returnedCount: number;
    estimatedCostUsd: number;
    coverage: StoredInteractionCoverage[];
    status: StoredInteractionJob['status'];
    errorCode?: string;
}) {
    const mutation = await supabaseAdmin
        .from('analysis_interaction_jobs')
        .upsert({
            request_id: input.requestId,
            kind: input.kind,
            batch_index: input.batchIndex,
            provider: 'apify',
            post_count: input.postCount,
            requested_per_post: input.requestedPerPost,
            requested_result_cap: input.postCount * input.requestedPerPost,
            returned_count: input.returnedCount,
            estimated_cost_usd: input.estimatedCostUsd,
            coverage: input.coverage,
            status: input.status,
            error_code: input.errorCode,
            updated_at: new Date().toISOString(),
        }, {
            onConflict: 'request_id,kind,batch_index',
        })
        .select('id')
        .maybeSingle();
    requireSingleMutationRow(mutation, 'interaction job upsert');
}

async function failLegacyRunningInteractionJob(
    requestId: string,
    kind: StoredInteractionJob['kind'],
    batchIndex: number
) {
    const mutation = await supabaseAdmin
        .from('analysis_interaction_jobs')
        .update({
            status: 'failed',
            error_code: 'INTERACTION_RUN_INTERRUPTED',
            updated_at: new Date().toISOString(),
        })
        .eq('request_id', requestId)
        .eq('kind', kind)
        .eq('batch_index', batchIndex)
        .eq('status', 'running')
        .select('id');
    if (mutation.error) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: interrupted interaction jobs update failed.');
    }
    if ((mutation.data?.length ?? 0) !== 1) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: legacy interaction job update missed.');
    }
    throw new Error(
        'INTERACTION_RUN_CHECKPOINT_ERROR: legacy interaction job cannot be resumed safely.'
    );
}

async function keepResumableInteractionJobRunning(
    error: unknown,
    requestId: string,
    operationKey: string
): Promise<boolean> {
    if (!isRetryablePipelineError(error)) return false;
    return Boolean(await getAnalysisProviderRun(supabaseAdmin, {
        requestId,
        operationKey,
    }));
}

async function persistInteractionEvidence(
    requestId: string,
    evidence: InteractionEvidenceRow[]
) {
    if (evidence.length === 0) return;
    const mutation = await supabaseAdmin
        .from('analysis_interaction_evidence')
        .upsert(evidence.map(row => ({
            request_id: requestId,
            candidate_username: row.candidateUsername,
            post_id: row.postId,
            signal: row.signal,
            source_interaction_id: row.sourceInteractionId,
            occurred_at: row.occurredAt,
            comment_text: row.content ?? null,
        })), {
            onConflict: 'request_id,candidate_username,signal,post_id,source_interaction_id',
            ignoreDuplicates: true,
        });
    if (mutation.error) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: interaction evidence upsert failed.');
    }
}

async function getInteractionJobs(
    requestId: string,
    kind?: StoredInteractionJob['kind']
): Promise<StoredInteractionJob[]> {
    let query = supabaseAdmin
        .from('analysis_interaction_jobs')
        .select('kind, batch_index, status, coverage')
        .eq('request_id', requestId);
    if (kind) query = query.eq('kind', kind);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: interaction jobs read failed.');
    }
    return data as StoredInteractionJob[];
}

async function getInteractionEvidence(requestId: string): Promise<InteractionEvidenceRow[]> {
    const data = await readBoundedDatabasePages(
        (from, to) => supabaseAdmin
            .from('analysis_interaction_evidence')
            .select('id, candidate_username, post_id, signal, source_interaction_id, occurred_at, comment_text')
            .eq('request_id', requestId)
            .order('id', { ascending: true })
            .range(from, to),
        { maximumRows: MAX_INTERACTION_EVIDENCE_ROWS }
    );
    return data.map(row => ({
        candidateUsername: row.candidate_username,
        postId: row.post_id,
        signal: row.signal as InteractionEvidenceRow['signal'],
        sourceInteractionId: row.source_interaction_id,
        ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}),
        ...(typeof row.comment_text === 'string' ? { content: row.comment_text } : {}),
    }));
}

async function collectTargetInteractionKind(input: {
    requestId: string;
    userId: string;
    kind: 'target_likers' | 'target_comments';
    posts: InstagramPost[];
    femaleUsernames: string[];
    existingStatus?: StoredInteractionJob['status'];
}) {
    const postLimit = input.kind === 'target_likers'
        ? TARGET_LIKER_POST_LIMIT
        : TARGET_COMMENT_POST_LIMIT;
    const posts = selectRecentInteractionPosts(input.posts, postLimit);
    const urls = posts.map(instagramPostUrl);
    const usage: InteractionUsage = { estimatedCostUsd: 0 };
    let likers: ApifyPostLiker[] = [];
    let comments: ApifyPostComment[] = [];
    const limit = input.kind === 'target_likers'
        ? TARGET_LIKER_LIMIT_PER_POST
        : TARGET_COMMENT_LIMIT_PER_POST;
    const operationKey = interactionOperationKey(input.kind, 0);
    const providerRun = await analysisProviderRunCheckpoint(supabaseAdmin, {
        requestId: input.requestId,
        userId: input.userId,
        expectedStep: 'interactions',
        operationKey,
    });
    if (
        input.existingStatus === 'running'
        && !providerRun.resumeRunId
        && !providerRun.startReserved
    ) {
        await failLegacyRunningInteractionJob(input.requestId, input.kind, 0);
    }

    await persistInteractionJob({
        requestId: input.requestId,
        kind: input.kind,
        batchIndex: 0,
        postCount: posts.length,
        requestedPerPost: limit,
        returnedCount: 0,
        estimatedCostUsd: 0,
        coverage: [],
        status: 'running',
    });

    try {
        if (input.kind === 'target_likers') {
            likers = await apifyInteractionAdapter.getPostLikers(
                urls,
                limit,
                interactionUsageContext(usage, providerRun)
            );
        } else {
            comments = await apifyInteractionAdapter.getPostComments(
                urls,
                limit,
                interactionUsageContext(usage, providerRun)
            );
        }
        const extracted = extractTargetInteractions(
            posts,
            likers,
            comments,
            input.femaleUsernames
        );
        const coverage = input.kind === 'target_likers'
            ? extracted.likerCoverage
            : extracted.commentCoverage;
        await persistInteractionEvidence(input.requestId, extracted.evidence);
        await persistInteractionJob({
            requestId: input.requestId,
            kind: input.kind,
            batchIndex: 0,
            postCount: posts.length,
            requestedPerPost: limit,
            returnedCount: input.kind === 'target_likers' ? likers.length : comments.length,
            estimatedCostUsd: usage.estimatedCostUsd,
            coverage,
            status: 'completed',
        });
    } catch (error) {
        if (await keepResumableInteractionJobRunning(
            error,
            input.requestId,
            operationKey
        )) {
            throw error;
        }
        await persistInteractionJob({
            requestId: input.requestId,
            kind: input.kind,
            batchIndex: 0,
            postCount: posts.length,
            requestedPerPost: limit,
            returnedCount: 0,
            estimatedCostUsd: usage.estimatedCostUsd,
            coverage: [],
            status: 'failed',
            errorCode: interactionErrorCode(error),
        });
        throw new Error(
            `${interactionErrorCode(error)}: target interaction collection failed.`
        );
    }
    await clearAnalysisProviderRun(supabaseAdmin, {
        requestId: input.requestId,
        operationKey,
    });
}

async function processTargetInteractions(
    requestId: string,
    userId: string,
    targetId: string,
    stepData: StepData,
    targetPosts: InstagramPost[],
    femaleAccounts: ReturnType<typeof femaleInteractionAccounts>,
    enabled: { likers: boolean; comments: boolean }
) {
    const existingJobs = await getInteractionJobs(requestId);
    const completedKinds = new Set(existingJobs
        .filter(job => job.status === 'completed')
        .map(job => job.kind));
    if (enabled.likers && existingJobs.some(job =>
        job.kind === 'target_likers' && job.status === 'failed'
    )) {
        throw new Error('INTERACTION_PROVIDER_ERROR: target liker job did not complete.');
    }
    if (enabled.comments && existingJobs.some(job =>
        job.kind === 'target_comments' && job.status === 'failed'
    )) {
        throw new Error('INTERACTION_PROVIDER_ERROR: target comment job did not complete.');
    }
    await Promise.all(existingJobs
        .filter(job => job.status === 'completed' && (
            (enabled.likers && job.kind === 'target_likers')
            || (enabled.comments && job.kind === 'target_comments')
        ))
        .map(job => clearAnalysisProviderRun(supabaseAdmin, {
            requestId,
            operationKey: interactionOperationKey(job.kind, job.batch_index),
        })));
    const femaleUsernames = femaleAccounts.map(account => account.profile.username);
    const tasks: Promise<void>[] = [];
    if (enabled.likers && !completedKinds.has('target_likers')) {
        const existing = existingJobs.find(job => job.kind === 'target_likers');
        tasks.push(collectTargetInteractionKind({
            requestId,
            userId,
            kind: 'target_likers',
            posts: targetPosts,
            femaleUsernames,
            existingStatus: existing?.status,
        }));
    }
    if (enabled.comments && !completedKinds.has('target_comments')) {
        const existing = existingJobs.find(job => job.kind === 'target_comments');
        tasks.push(collectTargetInteractionKind({
            requestId,
            userId,
            kind: 'target_comments',
            posts: targetPosts,
            femaleUsernames,
            existingStatus: existing?.status,
        }));
    }
    const taskResults = await Promise.allSettled(tasks);
    const rejectedTask = taskResults.find(result => result.status === 'rejected');
    if (rejectedTask?.status === 'rejected') throw rejectedTask.reason;

    const completedJobs = await getInteractionJobs(requestId);
    if (enabled.likers) {
        requireCompletedInteractionJob(completedJobs, 'target_likers', 0);
    }
    if (enabled.comments) {
        requireCompletedInteractionJob(completedJobs, 'target_comments', 0);
    }

    const evidence = await getInteractionEvidence(requestId);
    const observedCandidates = new Set(evidence
        .filter(row => row.signal !== 'target_female_like')
        .map(row => row.candidateUsername));
    const interactionCandidateUsernames = rankObservedInteractionCandidates(
        femaleAccounts.map(account => {
            const candidate = getCandidateIntermediateEvidence(targetId, stepData, account);
            return {
                username: candidate.username,
                intermediateScore: candidate.intermediateScore,
            };
        }),
        observedCandidates
    );
    const newStepData: StepData = {
        ...stepData,
        interactionStage: 'candidates',
        interactionCandidateUsernames,
        interactionCandidateBatchIndex: 0,
    };
    await updateStep(
        requestId,
        'interactions',
        newStepData,
        85,
        `대상 계정 상호작용 수집 완료 (${interactionCandidateUsernames.length}명 후속 확인)`
    );
    return NextResponse.json({
        success: true,
        step: 'interactions',
        done: false,
        stats: { interactionCandidates: interactionCandidateUsernames.length },
    });
}

async function processCandidateInteractionBatch(
    requestId: string,
    userId: string,
    targetId: string,
    stepData: StepData,
    femaleAccounts: ReturnType<typeof femaleInteractionAccounts>
) {
    const usernames = stepData.interactionCandidateUsernames ?? [];
    const batchIndex = stepData.interactionCandidateBatchIndex ?? 0;
    const totalBatches = Math.ceil(usernames.length / CANDIDATE_INTERACTION_BATCH_SIZE);
    if (batchIndex >= totalBatches) {
        const newStepData = { ...stepData, interactionStage: 'scoring' as const };
        await updateStep(requestId, 'interactions', newStepData, 91, '상호작용 점수 계산 준비 중...');
        return NextResponse.json({ success: true, step: 'interactions', done: false });
    }

    const existingJobs = await getInteractionJobs(requestId, 'candidate_likers');
    const existingJob = existingJobs.find(job => job.batch_index === batchIndex);
    if (existingJob?.status === 'failed') {
        throw new Error('INTERACTION_PROVIDER_ERROR: candidate liker job did not complete.');
    }
    const operationKey = interactionOperationKey('candidate_likers', batchIndex);
    if (existingJob?.status === 'completed') {
        await clearAnalysisProviderRun(supabaseAdmin, { requestId, operationKey });
    }
    if (!existingJob || existingJob.status === 'running') {
        const providerRun = await analysisProviderRunCheckpoint(supabaseAdmin, {
            requestId,
            userId,
            expectedStep: 'interactions',
            operationKey,
        });
        if (
            existingJob?.status === 'running'
            && !providerRun.resumeRunId
            && !providerRun.startReserved
        ) {
            await failLegacyRunningInteractionJob(
                requestId,
                'candidate_likers',
                batchIndex
            );
        }
        const batchUsernames = new Set(usernames.slice(
            batchIndex * CANDIDATE_INTERACTION_BATCH_SIZE,
            (batchIndex + 1) * CANDIDATE_INTERACTION_BATCH_SIZE
        ));
        const accounts: CandidateAccountPosts[] = femaleAccounts
            .filter(account => batchUsernames.has(account.profile.username.toLowerCase()))
            .map(account => ({
                username: account.profile.username,
                posts: selectRecentInteractionPosts(
                    candidatePostsFromStepData(account),
                    CANDIDATE_INTERACTION_POST_LIMIT
                ),
            }));
        const urls = accounts.flatMap(account => account.posts.map(instagramPostUrl));

        if (urls.length > 0) {
            const usage: InteractionUsage = { estimatedCostUsd: 0 };
            await persistInteractionJob({
                requestId,
                kind: 'candidate_likers',
                batchIndex,
                postCount: urls.length,
                requestedPerPost: CANDIDATE_LIKER_LIMIT_PER_POST,
                returnedCount: 0,
                estimatedCostUsd: 0,
                coverage: [],
                status: 'running',
            });
            try {
                const likers = await apifyInteractionAdapter.getPostLikers(
                    urls,
                    CANDIDATE_LIKER_LIMIT_PER_POST,
                    interactionUsageContext(usage, providerRun)
                );
                const extracted = extractCandidateInteractions(accounts, likers, targetId);
                await persistInteractionEvidence(requestId, extracted.evidence);
                await persistInteractionJob({
                    requestId,
                    kind: 'candidate_likers',
                    batchIndex,
                    postCount: urls.length,
                    requestedPerPost: CANDIDATE_LIKER_LIMIT_PER_POST,
                    returnedCount: likers.length,
                    estimatedCostUsd: usage.estimatedCostUsd,
                    coverage: extracted.coverage,
                    status: 'completed',
                });
            } catch (error) {
                if (await keepResumableInteractionJobRunning(
                    error,
                    requestId,
                    operationKey
                )) {
                    throw error;
                }
                await persistInteractionJob({
                    requestId,
                    kind: 'candidate_likers',
                    batchIndex,
                    postCount: urls.length,
                    requestedPerPost: CANDIDATE_LIKER_LIMIT_PER_POST,
                    returnedCount: 0,
                    estimatedCostUsd: usage.estimatedCostUsd,
                    coverage: [],
                    status: 'failed',
                    errorCode: interactionErrorCode(error),
                });
                throw new Error(
                    `${interactionErrorCode(error)}: candidate interaction collection failed.`
                );
            }
            await clearAnalysisProviderRun(supabaseAdmin, { requestId, operationKey });
        }
    }

    const nextBatchIndex = batchIndex + 1;
    const progress = 85 + Math.round((nextBatchIndex / totalBatches) * 6);
    const newStepData: StepData = {
        ...stepData,
        interactionCandidateBatchIndex: nextBatchIndex,
    };
    await updateStep(
        requestId,
        'interactions',
        newStepData,
        progress,
        `후보 계정 상호작용 확인 중... (${nextBatchIndex}/${totalBatches})`
    );
    return NextResponse.json({
        success: true,
        step: 'interactions',
        done: false,
        batchProgress: { current: nextBatchIndex, total: totalBatches },
    });
}

async function processInteractionScores(
    requestId: string,
    targetId: string,
    stepData: StepData,
    targetPosts: InstagramPost[],
    femaleAccounts: ReturnType<typeof femaleInteractionAccounts>
) {
    const [jobs, evidence] = await Promise.all([
        getInteractionJobs(requestId),
        getInteractionEvidence(requestId),
    ]);
    requireNoIncompleteInteractionJobs(jobs);
    const completedJobs = jobs.filter(job => job.status === 'completed');
    const targetLikeCoverage = completedJobs
        .filter(job => job.kind === 'target_likers')
        .flatMap(job => parseStoredInteractionCoverage(job.coverage));
    const targetCommentCoverage = completedJobs
        .filter(job => job.kind === 'target_comments')
        .flatMap(job => parseStoredInteractionCoverage(job.coverage));
    const candidateLikeCoverage = completedJobs
        .filter(job => job.kind === 'candidate_likers')
        .flatMap(job => parseStoredInteractionCoverage(job.coverage));

    const scoreRows = femaleAccounts.map(account => {
        const intermediate = getCandidateIntermediateEvidence(targetId, stepData, account);
        const score = scoreCandidateInteractions({
            targetPosts,
            candidatePosts: candidatePostsFromStepData(account),
            candidateUsername: account.profile.username,
            evidence,
            targetLikeCoverage,
            targetCommentCoverage,
            candidateLikeCoverage,
        });
        return {
            request_id: requestId,
            candidate_username: account.profile.username.toLowerCase(),
            score: score.score,
            coverage: score.coverage,
            coverage_status: score.coverageStatus,
            female_to_target_likes_count: score.femaleToTargetLikesCount,
            female_to_target_comments_count: score.femaleToTargetCommentsCount,
            target_to_female_likes_count: score.targetToFemaleLikesCount,
            intermediate_score: intermediate.intermediateScore,
            recency_bonus: intermediate.recencyBonus,
            breakdown: score.breakdown,
            updated_at: new Date().toISOString(),
        };
    });
    if (scoreRows.length > 0) {
        const mutation = await supabaseAdmin
            .from('analysis_interaction_scores')
            .upsert(scoreRows, { onConflict: 'request_id,candidate_username' });
        if (mutation.error) {
            throw new Error('ANALYSIS_PERSISTENCE_ERROR: interaction scores upsert failed.');
        }
    }

    const newStepData: StepData = {
        ...stepData,
        interactionStage: 'complete',
        deepAnalysisStage: 'pending',
    };
    await updateStep(requestId, 'deep_analysis', newStepData, 92, '위험 계정 심층 분석 준비 중...');
    return NextResponse.json({
        success: true,
        step: 'deep_analysis',
        done: false,
        stats: { interactionScores: scoreRows.length },
    });
}

// Step 4: 관측된 양방향 좋아요/댓글 수집 + 커버리지 점수화
async function processInteractions(
    requestId: string,
    userId: string,
    targetId: string,
    stepData: StepData
) {
    const targetPosts = targetPostsFromStepData(stepData);
    const femaleAccounts = femaleInteractionAccounts(stepData);
    const enabled = {
        likers: stepData.scraperOptions?.likers !== 'disabled',
        comments: stepData.scraperOptions?.comments !== 'disabled',
    };
    if (targetPosts.length === 0 || femaleAccounts.length === 0) {
        return processInteractionScores(requestId, targetId, stepData, targetPosts, femaleAccounts);
    }
    if (!enabled.likers && !enabled.comments) {
        return processInteractionScores(requestId, targetId, stepData, targetPosts, femaleAccounts);
    }

    switch (stepData.interactionStage ?? 'target') {
        case 'target':
            return processTargetInteractions(
                requestId,
                userId,
                targetId,
                stepData,
                targetPosts,
                femaleAccounts,
                enabled
            );
        case 'candidates':
            if (!enabled.likers) {
                return processInteractionScores(requestId, targetId, stepData, targetPosts, femaleAccounts);
            }
            return processCandidateInteractionBatch(
                requestId,
                userId,
                targetId,
                stepData,
                femaleAccounts
            );
        case 'scoring':
        case 'complete':
            return processInteractionScores(requestId, targetId, stepData, targetPosts, femaleAccounts);
    }
}

interface PersistedInteractionScore {
    candidate_username: string;
    score: number | string;
    coverage: number | string;
    coverage_status: 'high' | 'medium' | 'low';
    female_to_target_likes_count: number;
    female_to_target_comments_count: number;
    target_to_female_likes_count: number;
    intermediate_score: number | string;
    recency_bonus: number | string;
    deep_analysis: unknown;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return minimum;
    return Math.min(maximum, Math.max(minimum, number));
}

function parseDeepAnalysisLines(value: unknown): [string, string] | null {
    return parseSafePublicRiskNarrative(value);
}

function recentMutualOrder(username: string, orderedMutuals: readonly string[]): number | undefined {
    const target = normalizedUsername(username);
    const seen = new Set<string>();
    for (const value of orderedMutuals) {
        const key = normalizedUsername(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (key === target) return seen.size;
    }
    return undefined;
}

function boundedOptionalText(value: string | undefined, maximum: number): string | undefined {
    const normalized = value
        ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized ? normalized.slice(0, maximum) : undefined;
}

function fallbackDeepAnalysis(
    score: PersistedInteractionScore,
    commentText?: string
): [string, string] {
    return buildSafeFallbackRiskNarrative({
        candidateLikedTarget: score.female_to_target_likes_count > 0,
        candidateCommentedOnTarget: score.female_to_target_comments_count > 0,
        targetLikedCandidate: score.target_to_female_likes_count > 0,
        commentText,
    });
}

async function getPersistedInteractionScores(
    requestId: string
): Promise<PersistedInteractionScore[]> {
    const { data, error } = await supabaseAdmin
        .from('analysis_interaction_scores')
        .select(`
            candidate_username,
            score,
            coverage,
            coverage_status,
            female_to_target_likes_count,
            female_to_target_comments_count,
            target_to_female_likes_count,
            intermediate_score,
            recency_bonus,
            deep_analysis
        `)
        .eq('request_id', requestId);
    if (error || !Array.isArray(data)) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: interaction scores read failed.');
    }
    return data as PersistedInteractionScore[];
}

// Step 5: 최상위 위험 계정의 프로필·피드·상호작용 근거를 병렬 심층 분석
async function processDeepAnalysis(
    requestId: string,
    userId: string,
    targetId: string,
    stepData: StepData
) {
    rejectUnresolvedGeminiGeneration(stepData);
    const femaleAccounts = femaleInteractionAccounts(stepData);
    const [scores, evidence] = await Promise.all([
        getPersistedInteractionScores(requestId),
        getInteractionEvidence(requestId),
    ]);
    const scoreByUsername = new Map(
        scores.map(score => [normalizedUsername(score.candidate_username), score])
    );
    const rankedAccounts = femaleAccounts
        .map(account => ({
            account,
            username: normalizedUsername(account.profile.username),
            score: scoreByUsername.get(normalizedUsername(account.profile.username)),
        }))
        .filter((entry): entry is typeof entry & { score: PersistedInteractionScore } =>
            entry.score !== undefined
        )
        .sort((left, right) => {
            const leftTotal = boundedNumber(left.score.intermediate_score, 0, 190)
                + boundedNumber(left.score.score, 0, 100);
            const rightTotal = boundedNumber(right.score.intermediate_score, 0, 190)
                + boundedNumber(right.score.score, 0, 100);
            return rightTotal - leftTotal || left.username.localeCompare(right.username);
        });
    const highRiskAccounts = rankedAccounts.slice(
        0,
        Math.min(getHighRiskCount(rankedAccounts.length), rankedAccounts.length)
    );
    const orderedMutuals = orderedMutualUsernamesFromStepData(stepData);
    const recentRanks = inferRecentMutualFemaleRanks(
        orderedMutuals,
        femaleAccounts.map(account => account.profile.username)
    );

    if (highRiskAccounts.length === 0) {
        const newStepData: StepData = { ...stepData, deepAnalysisStage: 'complete' };
        await updateStep(requestId, 'finalize', newStepData, 97, '결과 저장 준비 중...');
        return NextResponse.json({
            success: true,
            step: 'finalize',
            done: false,
            stats: { deepRiskAccounts: 0 },
        });
    }

    const generationStepData = beginGeminiGeneration(
        { ...stepData, deepAnalysisStage: 'pending' },
        {
            kind: 'deep_risk',
            operationKey: 'deep-risk:0',
            inputIds: highRiskAccounts.map(entry => entry.username),
        }
    );
    await updateStep(
        requestId,
        'deep_analysis',
        generationStepData,
        94,
        `위험 계정 심층 분석 중... (${highRiskAccounts.length}명)`
    );
    await recordGeminiUsageExpectation(supabaseAdmin, {
        requestId,
        userId,
        expectedStep: 'deep_analysis',
        operationKey: 'deep-risk:0',
        generationKind: 'deep_risk',
        expectedRecordCount: highRiskAccounts.length,
    });

    const deepAnalysisResults = await Promise.allSettled(
        highRiskAccounts.map(async ({ account, username, score }) => {
        const candidateEvidence = evidence.filter(
            row => normalizedUsername(row.candidateUsername) === username
        );
        const intermediate = getCandidateIntermediateEvidence(targetId, stepData, account);
        const deepInput: DeepRiskNarrativeInput = {
                targetUsername: normalizedUsername(targetId),
                profile: {
                    username,
                    ...(boundedOptionalText(account.profile.fullName, 200)
                        ? { fullName: boundedOptionalText(account.profile.fullName, 200) }
                        : {}),
                    ...(boundedOptionalText(account.profile.bio, 2_000)
                        ? { bio: boundedOptionalText(account.profile.bio, 2_000) }
                        : {}),
                    ...(account.profile.profilePicUrl
                        ? { profilePicUrl: account.profile.profilePicUrl }
                        : {}),
                },
                recentPosts: account.recentPosts.map(post => ({
                    id: post.id.slice(0, 200),
                    shortCode: post.shortCode.slice(0, 100),
                    ...(boundedOptionalText(post.caption, 5_000)
                        ? { caption: boundedOptionalText(post.caption, 5_000) }
                        : {}),
                    ...(post.imageUrl ? { imageUrl: post.imageUrl } : {}),
                    timestamp: post.timestamp,
                })),
                featureEvidence: {
                    intermediateScore: boundedNumber(score.intermediate_score, 0, 190),
                    photogenicGrade: intermediate.photogenicGrade,
                    skinVisibility: intermediate.exposureLevel,
                    ownerIdentified: intermediate.ownerIdentified,
                    isTaggedByTarget: intermediate.isTagged,
                    isMarried: intermediate.isMarried,
                    isForeigner: intermediate.isForeigner,
                },
                recencyEvidence: {
                    mutualOrder: recentMutualOrder(username, orderedMutuals),
                    recentMutualRank: recentRanks.get(username),
                    recencyBonus: boundedNumber(score.recency_bonus, 0, 20),
                },
                interactionEvidence: {
                    interactionScore: boundedNumber(score.score, 0, 100),
                    femaleLikedTarget: score.female_to_target_likes_count > 0,
                    femaleToTargetLikesCount: score.female_to_target_likes_count,
                    femaleCommentedOnTarget: score.female_to_target_comments_count > 0,
                    femaleToTargetCommentsCount: score.female_to_target_comments_count,
                    targetLikedFemale: score.target_to_female_likes_count > 0,
                    targetToFemaleLikesCount: score.target_to_female_likes_count,
                    matchedComments: candidateEvidence
                        .filter(row => row.signal === 'female_target_comment' && row.content)
                        .map(row => ({
                            id: row.sourceInteractionId,
                            postId: row.postId,
                            text: row.content as string,
                            ...(row.occurredAt ? { timestamp: row.occurredAt } : {}),
                        })),
                    coverage: boundedNumber(score.coverage, 0, 1),
                    coverageStatus: score.coverage_status,
                },
                requestId,
            };
        if (parseDeepRiskNarrativeForInput(score.deep_analysis, deepInput)) return;

        const fallback = fallbackDeepAnalysis(
            score,
            deepInput.interactionEvidence.matchedComments[0]?.text
        );
        let lines = fallback;
        try {
            const result = await analyzeDeepRiskNarrative(deepInput);
            lines = parseDeepRiskNarrativeForInput(result.lines, deepInput)?.lines ?? fallback;
        } catch (error) {
            if (isAmbiguousGeminiGenerationError(error)) throw error;
            console.error('Deep risk narrative analysis failed for one account', {
                requestId,
            });
        }

        const mutation = await supabaseAdmin
            .from('analysis_interaction_scores')
            .update({ deep_analysis: lines, updated_at: new Date().toISOString() })
            .eq('request_id', requestId)
            .eq('candidate_username', username)
            .select('id')
            .maybeSingle();
        try {
            requireSingleMutationRow(mutation, 'deep risk analysis update');
        } catch {
            // The Gemini request may already have been billed. Replaying it after
            // losing the result would trade a database outage for duplicate cost.
            throw new Error(
                'AI_RESULT_PERSISTENCE_ERROR: generated deep analysis could not be checkpointed.'
            );
        }
        })
    );
    const deepAnalysisFailure = deepAnalysisResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (deepAnalysisFailure) throw deepAnalysisFailure.reason;

    const newStepData: StepData = clearGeminiGeneration({
        ...generationStepData,
        deepAnalysisStage: 'complete',
    });
    await updateStep(requestId, 'finalize', newStepData, 97, '결과 저장 준비 중...');
    return NextResponse.json({
        success: true,
        step: 'finalize',
        done: false,
        stats: { deepRiskAccounts: highRiskAccounts.length },
    });
}

// Step 6: 점수 계산 + 결과 저장
async function processFinalize(
    requestId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    analysisRequest: any,
    stepData: StepData
) {
    const targetId = analysisRequest.target_instagram_id;
    const accountsWithPosts = stepData.accountsWithPosts || [];
    const combinedResults = stepData.combinedResults || {};
    const interactionScoreRows = await getPersistedInteractionScores(requestId);
    const interactionScores = new Map(
        interactionScoreRows.map(row => [normalizedUsername(row.candidate_username), row])
    );

    // 레거시 데이터 지원 (하위 호환성)
    const legacyGenderResults = stepData.genderResults || {};
    const legacyPhotogenicResults = stepData.photogenicResults || {};
    const legacyExposureResults = stepData.exposureResults || {};

    await updateStep(requestId, 'finalize', stepData, 97, '점수 계산 중...');

    const analyzedAccounts: AnalyzedAccount[] = [];

    for (const account of accountsWithPosts) {
        const username = account.profile.username;

        // 통합 결과 또는 레거시 결과 사용
        const combinedResult = combinedResults[username];
        const legacyGender = legacyGenderResults[username];
        const legacyPhotogenic = legacyPhotogenicResults[username];
        const legacyExposure = legacyExposureResults[username];

        // 성별 판단
        const gender = combinedResult?.gender || legacyGender?.gender || 'unknown';
        const genderConfidence = combinedResult?.genderConfidence || legacyGender?.confidence || 0;

        // 여성이 아니면 건너뛰기
        const { include, status: genderStatus } = classifyGenderStatus(gender, genderConfidence);
        if (!include) continue;

        const intermediate = getCandidateIntermediateEvidence(targetId, stepData, account);
        const photogenicGrade = combinedResult?.photogenicGrade
            || legacyPhotogenic?.photogenicGrade
            || intermediate.photogenicGrade;
        const exposureLevel = combinedResult?.skinVisibility
            || legacyExposure?.skinVisibility
            || intermediate.exposureLevel;
        const interaction = interactionScores.get(normalizedUsername(username));
        const interactionScore = boundedNumber(interaction?.score, 0, 100);
        const intermediateScore = interaction
            ? boundedNumber(interaction.intermediate_score, 0, 190)
            : intermediate.intermediateScore;
        const recencyBonus = interaction
            ? boundedNumber(interaction.recency_bonus, 0, 20)
            : intermediate.recencyBonus;
        const totalScore = intermediateScore + interactionScore;

        analyzedAccounts.push({
            username,
            fullName: account.profile.fullName,
            profilePicUrl: account.profile.profilePicUrl,
            bio: account.profile.bio,
            isPrivate: account.profile.isPrivate,
            gender,
            genderConfidence,
            genderStatus,
            photogenicGrade,
            exposureLevel,
            isTagged: intermediate.isTagged,
            totalScore,
            interactionScore,
            interactionCoverage: Number(interaction?.coverage ?? 0),
            interactionCoverageStatus: interaction?.coverage_status ?? 'low',
            femaleToTargetLikesCount: interaction?.female_to_target_likes_count ?? 0,
            femaleToTargetCommentsCount: interaction?.female_to_target_comments_count ?? 0,
            targetToFemaleLikesCount: interaction?.target_to_female_likes_count ?? 0,
            recencyBonus,
            riskAnalysis: parseDeepAnalysisLines(interaction?.deep_analysis) ?? [],
        });
    }

    await updateStep(requestId, 'finalize', stepData, 98, '위험순위 분류 중...');

    // 점수순 정렬
    analyzedAccounts.sort((a, b) =>
        b.totalScore - a.totalScore || a.username.localeCompare(b.username)
    );

    // 위험순위 부여
    const rankedAccounts = analyzedAccounts.map((account, index) => ({
        ...account,
        rank: index + 1,
        riskGrade: classifyRiskGrade(index + 1, analyzedAccounts.length),
    }));

    await updateStep(requestId, 'finalize', stepData, 99, '결과 저장 중...');

    // A multi-row upsert is atomic and remains idempotent if completion persistence is interrupted.
    const resultRows = rankedAccounts.map(result => ({
            request_id: requestId,
            rank: result.rank,
            suspect_instagram_id: result.username,
            suspect_full_name: result.fullName,
            suspect_profile_image: result.profilePicUrl,
            bio: result.bio,
            risk_score: Math.round(result.totalScore),
            interaction_score: result.interactionScore,
            interaction_coverage: result.interactionCoverage,
            interaction_coverage_status: result.interactionCoverageStatus,
            female_to_target_likes_count: result.femaleToTargetLikesCount,
            female_to_target_comments_count: result.femaleToTargetCommentsCount,
            target_to_female_likes_count: result.targetToFemaleLikesCount,
            recency_bonus: result.recencyBonus,
            risk_analysis: result.riskAnalysis ?? [],
            photogenic_grade: result.photogenicGrade,
            exposure_level: result.exposureLevel,
            is_tagged: result.isTagged,
            risk_grade: result.riskGrade,
            gender_confidence: result.genderConfidence,
            gender_status: result.genderStatus,
            is_unlocked: true,
        }));
    if (resultRows.length > 0) {
        const insertedResults = await supabaseAdmin
            .from('analysis_results')
            .upsert(resultRows, { onConflict: 'request_id,suspect_instagram_id' })
            .select('id');
        requireInsertedMutationRows(insertedResults, resultRows.length, 'analysis results insert');
    }

    await completeAnalysisRequest(supabaseAdmin, {
        requestId,
        userId: analysisRequest.user_id,
        compactStepData: compactCompletedStepData(stepData),
    });

    // 이메일 알림 발송
    if (analysisRequest.users?.email) {
        try {
            await sendAnalysisCompleteEmail(
                analysisRequest.users.email,
                targetId,
                requestId
            );
        } catch {
            console.error('Email sending failed', { requestId });
        }
    }

    return NextResponse.json({
        success: true,
        step: 'completed',
        done: true,
        stats: {
            totalAnalyzed: rankedAccounts.length,
        },
    });
}
