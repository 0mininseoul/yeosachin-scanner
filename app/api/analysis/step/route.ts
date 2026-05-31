import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import {
    getInstagramProfile,
    getFollowers,
    getFollowing,
    extractMutualFollows,
    classifyByPrivacy,
    getProfilesBatch,
} from '@/lib/services/instagram/scraper';
import { analyzeCombined } from '@/lib/services/ai/combined-analysis';
import {
    getPhotogenicScore,
    getExposureScore,
    classifyGenderStatus,
    classifyRiskGrade,
    TAG_SCORE,
} from '@/lib/constants/scoring';
import { sendAnalysisCompleteEmail } from '@/lib/services/email';
import type { AnalyzedAccount } from '@/lib/types/analysis';
import {
    type AnalysisStep,
    type StepData,
    BATCH_SIZE,
    PROFILE_BATCH_SIZE,
    calculateBatchProgress,
} from '@/lib/services/analysis/steps';

// 단계별 분석 처리 API
export async function POST(request: Request) {
    try {
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

        if (fetchError || !analysisRequest) {
            return NextResponse.json({ error: 'Request not found' }, { status: 404 });
        }

        // 이미 완료되었거나 실패한 경우
        if (analysisRequest.status === 'completed' || analysisRequest.status === 'failed') {
            return NextResponse.json({
                success: true,
                step: analysisRequest.current_step,
                status: analysisRequest.status,
                done: true,
            });
        }

        const currentStep = (analysisRequest.current_step || 'pending') as AnalysisStep;
        const stepData: StepData = analysisRequest.step_data || {};
        const targetId = analysisRequest.target_instagram_id;
        const planType = analysisRequest.plan_type || 'basic';
        const scrapeLimit = planType === 'standard' ? 1000 : 500;

        try {
            // 현재 단계에 따라 처리
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
                    return await processCollect(requestId, targetId, scrapeLimit, stepData);

                case 'profiles':
                    return await processProfiles(requestId, targetId, stepData);

                case 'analyze':
                    return await processAnalyze(requestId, stepData);

                case 'finalize':
                    return await processFinalize(requestId, analysisRequest, stepData);

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
        } catch (pipelineError) {
            const errorMessage = pipelineError instanceof Error ? pipelineError.message : 'Unknown error';
            console.error(`Step ${currentStep} error:`, pipelineError);

            await supabaseAdmin
                .from('analysis_requests')
                .update({
                    status: 'failed',
                    current_step: 'failed',
                    error_message: errorMessage,
                })
                .eq('id', requestId);

            return NextResponse.json({ error: errorMessage, step: currentStep }, { status: 500 });
        }
    } catch (error) {
        console.error('Step API error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Step failed' },
            { status: 500 }
        );
    }
}

// 상태 업데이트 헬퍼
async function updateStep(
    requestId: string,
    step: AnalysisStep,
    stepData: StepData,
    progress: number,
    progressStep: string
) {
    await supabaseAdmin
        .from('analysis_requests')
        .update({
            status: 'processing',
            current_step: step,
            step_data: stepData,
            progress,
            progress_step: progressStep,
        })
        .eq('id', requestId);
}

// Step 1: 프로필 + 팔로워/팔로잉 수집 + 맞팔 추출
async function processCollect(
    requestId: string,
    targetId: string,
    scrapeLimit: number,
    stepData: StepData
) {
    // 프로필 수집
    await updateStep(requestId, 'collect', stepData, 5, '대상 계정 정보 수집 중...');
    const profile = await getInstagramProfile(targetId);

    if (!profile) {
        throw new Error('계정을 찾을 수 없습니다.');
    }

    if (profile.isPrivate) {
        throw new Error('비공개 계정은 분석할 수 없습니다.');
    }

    // 팔로워/팔로잉 수집
    await updateStep(requestId, 'collect', stepData, 15, '팔로워/팔로잉 목록 수집 중...');
    const [followers, following] = await Promise.all([
        getFollowers(targetId, scrapeLimit),
        getFollowing(targetId, scrapeLimit),
    ]);

    // 맞팔 추출
    await updateStep(requestId, 'collect', stepData, 25, '맞팔 계정 분석 중...');
    const mutualFollows = extractMutualFollows(followers, following);

    // 공개/비공개 분류
    const { publicAccounts, privateAccounts } = classifyByPrivacy(mutualFollows);

    // 비공개 계정 저장
    if (privateAccounts.length > 0) {
        await supabaseAdmin.from('private_accounts').insert(
            privateAccounts.map((account) => ({
                request_id: requestId,
                instagram_id: account.username,
                profile_image: account.profilePicUrl,
                full_name: account.fullName,
            }))
        );
    }

    // 통계 업데이트
    await supabaseAdmin
        .from('analysis_requests')
        .update({
            total_followers: followers.length,
            mutual_follows: mutualFollows.length,
        })
        .eq('id', requestId);

    // step_data 업데이트
    const newStepData: StepData = {
        ...stepData,
        mutualFollows: mutualFollows.map((m) => m.username),
        publicAccounts: publicAccounts.slice(0, 350).map((a) => ({
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
    targetId: string,
    stepData: StepData
) {
    const publicAccounts = stepData.publicAccounts || [];
    const batchIndex = stepData.profileBatchIndex || 0;
    const accountsWithPosts = stepData.accountsWithPosts || [];

    if (publicAccounts.length === 0) {
        // 공개 계정이 없으면 바로 완료
        await updateStep(requestId, 'finalize', stepData, 90, '결과 저장 중...');
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

    // 프로필 배치 수집 (latestPosts 포함)
    const profiles = await getProfilesBatch(batch.map((a) => a.username));

    // 프로필과 게시물 매핑 (latestPosts 사용 - 별도 API 호출 불필요)
    const batchAccountsWithPosts = profiles.map((profile) => {
        const posts = profile.latestPosts || [];
        // bio가 없으면 externalUrl을 대신 사용
        const displayBio = profile.bio || profile.externalUrl;
        return {
            profile: {
                username: profile.username,
                profilePicUrl: profile.profilePicUrl,
                fullName: profile.fullName,
                bio: displayBio,
                isPrivate: profile.isPrivate,
            },
            recentPosts: posts.map((p) => ({
                imageUrl: p.imageUrl,
                taggedUsers: p.taggedUsers,
                mentionedUsers: p.mentionedUsers,
            })),
        };
    });

    // 기존 결과에 추가
    const updatedAccountsWithPosts = [...accountsWithPosts, ...batchAccountsWithPosts];

    const newStepData: StepData = {
        ...stepData,
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
async function processAnalyze(requestId: string, stepData: StepData) {
    const accountsWithPosts = stepData.accountsWithPosts || [];
    const batchIndex = stepData.analyzeBatchIndex || 0;
    const combinedResults = stepData.combinedResults || {};

    const totalBatches = Math.ceil(accountsWithPosts.length / BATCH_SIZE);

    if (batchIndex >= totalBatches) {
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

        await supabaseAdmin
            .from('analysis_requests')
            .update({
                opposite_gender_count: femaleCount,
                gender_stats: genderStats,
            })
            .eq('id', requestId);

        const newStepData: StepData = {
            ...stepData,
            combinedResults,
        };

        await updateStep(requestId, 'finalize', newStepData, 90, '결과 저장 준비 중...');

        return NextResponse.json({
            success: true,
            step: 'finalize',
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

    // 배치 통합 분석 (5개씩 병렬 처리)
    const subBatchSize = 5;
    for (let i = 0; i < batch.length; i += subBatchSize) {
        const subBatch = batch.slice(i, i + subBatchSize);
        const results = await Promise.all(
            subBatch.map(async (account) => {
                try {
                    const result = await analyzeCombined({
                        profile: account.profile as Parameters<typeof analyzeCombined>[0]['profile'],
                        recentPosts: account.recentPosts as Parameters<typeof analyzeCombined>[0]['recentPosts'],
                        requestId, // 토큰 추적용
                    });
                    return { username: account.profile.username, result };
                } catch (error) {
                    console.error(`Combined analysis failed for ${account.profile.username}:`, error);
                    return {
                        username: account.profile.username,
                        result: {
                            gender: 'unknown' as const,
                            genderConfidence: 0,
                            genderReasoning: 'Analysis failed',
                        },
                    };
                }
            })
        );

        for (const { username, result } of results) {
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

// Step 4: 점수 계산 + 결과 저장
async function processFinalize(
    requestId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    analysisRequest: any,
    stepData: StepData
) {
    const targetId = analysisRequest.target_instagram_id;
    const accountsWithPosts = stepData.accountsWithPosts || [];
    const combinedResults = stepData.combinedResults || {};

    // 레거시 데이터 지원 (하위 호환성)
    const legacyGenderResults = stepData.genderResults || {};
    const legacyPhotogenicResults = stepData.photogenicResults || {};
    const legacyExposureResults = stepData.exposureResults || {};

    await updateStep(requestId, 'finalize', stepData, 92, '점수 계산 중...');

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

        // 태그 확인
        let isTagged = false;
        for (const post of account.recentPosts) {
            if (post.taggedUsers?.includes(targetId) || post.mentionedUsers?.includes(targetId)) {
                isTagged = true;
                break;
            }
        }

        // 점수 계산 (통합 결과 또는 레거시 결과 사용)
        const photogenicGrade = combinedResult?.photogenicGrade || legacyPhotogenic?.photogenicGrade || 1;
        const exposureLevel = combinedResult?.skinVisibility || legacyExposure?.skinVisibility || 'low';
        const isMarried = combinedResult?.isMarried || false;
        const isForeigner = combinedResult?.isForeigner || false;

        // 기혼녀 또는 해외 계정인 경우 점수 0점 처리 (위험하지 않음)
        let totalScore = 0;
        if (!isMarried && !isForeigner) {
            const photogenicScore = getPhotogenicScore(photogenicGrade);
            const exposureScore = getExposureScore(exposureLevel);
            const tagScore = isTagged ? TAG_SCORE : 0;
            totalScore = photogenicScore + exposureScore + tagScore;
        }

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
            isTagged,
            totalScore,
        });
    }

    await updateStep(requestId, 'finalize', stepData, 95, '위험순위 분류 중...');

    // 점수순 정렬
    analyzedAccounts.sort((a, b) => b.totalScore - a.totalScore);

    // 위험순위 부여
    const rankedAccounts = analyzedAccounts.map((account, index) => ({
        ...account,
        rank: index + 1,
        riskGrade: classifyRiskGrade(index + 1, analyzedAccounts.length),
    }));

    await updateStep(requestId, 'finalize', stepData, 97, '결과 저장 중...');

    // 결과 저장
    for (const result of rankedAccounts) {
        await supabaseAdmin.from('analysis_results').insert({
            request_id: requestId,
            rank: result.rank,
            suspect_instagram_id: result.username,
            suspect_full_name: result.fullName,
            suspect_profile_image: result.profilePicUrl,
            bio: result.bio,
            risk_score: result.totalScore,
            photogenic_grade: result.photogenicGrade,
            exposure_level: result.exposureLevel,
            is_tagged: result.isTagged,
            risk_grade: result.riskGrade,
            gender_confidence: result.genderConfidence,
            gender_status: result.genderStatus,
            is_unlocked: true,
        });
    }

    // 완료 상태 업데이트
    await supabaseAdmin
        .from('analysis_requests')
        .update({
            status: 'completed',
            current_step: 'completed',
            progress: 100,
            progress_step: '분석 완료!',
            completed_at: new Date().toISOString(),
        })
        .eq('id', requestId);

    // 이메일 알림 발송
    if (analysisRequest.users?.email) {
        try {
            await sendAnalysisCompleteEmail(
                analysisRequest.users.email,
                targetId,
                requestId
            );
        } catch (emailError) {
            console.error('Email sending failed:', emailError);
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
