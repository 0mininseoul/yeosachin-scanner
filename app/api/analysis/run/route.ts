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
import { analyzeGenderBatch } from '@/lib/services/ai/gender-analysis';
import { analyzePhotogenicBatch } from '@/lib/services/ai/photogenic-analysis';
import { analyzeExposureBatch } from '@/lib/services/ai/exposure-analysis';
import {
    getPhotogenicScore,
    getExposureScore,
    classifyGenderStatus,
    classifyRiskGrade,
    TAG_SCORE,
} from '@/lib/constants/scoring';
import { sendAnalysisCompleteEmail } from '@/lib/services/email';
import type { AnalyzedAccount } from '@/lib/types/analysis';

// 분석 실행 API (내부용 - 직접 호출하지 않음)
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

        if (analysisRequest.status !== 'pending') {
            return NextResponse.json({ error: 'Already processing or completed' }, { status: 400 });
        }

        // 상태 업데이트 함수
        const updateProgress = async (progress: number, step: string) => {
            await supabaseAdmin
                .from('analysis_requests')
                .update({ status: 'processing', progress, progress_step: step })
                .eq('id', requestId);
        };

        const targetId = analysisRequest.target_instagram_id;
        const planType = analysisRequest.plan_type || 'basic'; // basic or standard
        const scrapeLimit = planType === 'standard' ? 1000 : 500;

        try {
            // Step 1: 프로필 수집 (5%)
            await updateProgress(5, '대상 계정 정보 수집 중...');
            const profile = await getInstagramProfile(targetId);

            if (!profile) {
                throw new Error('계정을 찾을 수 없습니다.');
            }

            if (profile.isPrivate) {
                throw new Error('비공개 계정은 분석할 수 없습니다.');
            }

            // Step 2: 팔로워/팔로잉 수집 (15%)
            await updateProgress(15, '팔로워/팔로잉 목록 수집 중...');
            const [followers, following] = await Promise.all([
                getFollowers(targetId, scrapeLimit),
                getFollowing(targetId, scrapeLimit),
            ]);

            // Step 3: 맞팔 추출 (25%)
            await updateProgress(25, '맞팔 계정 분석 중...');
            const mutualFollows = extractMutualFollows(followers, following);

            await supabaseAdmin
                .from('analysis_requests')
                .update({
                    total_followers: followers.length,
                    mutual_follows: mutualFollows.length,
                })
                .eq('id', requestId);

            // Step 4: 공개/비공개 분류 (30%)
            await updateProgress(30, '공개/비공개 계정 분류 중...');
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

            // Step 5: 공개 계정 프로필 스크래핑 (45%) - 최대 350개
            // 프로파일 수집 시 latestPosts도 함께 반환됨 (instagram-profile-scraper)
            await updateProgress(45, '공개 계정 프로필 수집 중...');
            const profilesToScrape = publicAccounts.slice(0, 350);
            const profiles = await getProfilesBatch(profilesToScrape.map(a => a.username));

            // 프로필과 게시물 매핑 (latestPosts 사용 - 별도 API 호출 불필요)
            const accountsWithPosts = profiles.map((profile) => ({
                profile,
                recentPosts: profile.latestPosts || [],
            }));

            // Step 6: 성별 판단 (60%)
            await updateProgress(60, '계정 성별 분석 중...');
            const genderResults = await analyzeGenderBatch(accountsWithPosts);

            // 성별 통계 계산
            const genderStats = { male: 0, female: 0, unknown: 0 };
            const femaleAccounts: typeof accountsWithPosts = [];

            for (const account of accountsWithPosts) {
                const result = genderResults.get(account.profile.username);
                if (!result) continue;

                if (result.gender === 'male') genderStats.male++;
                else if (result.gender === 'female') genderStats.female++;
                else genderStats.unknown++;

                // 여성 계정 필터링 (확정 + 의심)
                const { include } = classifyGenderStatus(result.gender, result.confidence);
                if (include) {
                    femaleAccounts.push(account);
                }
            }

            await supabaseAdmin
                .from('analysis_requests')
                .update({
                    opposite_gender_count: femaleAccounts.length,
                    gender_stats: genderStats,
                })
                .eq('id', requestId);

            // Step 7: 계정 분석 (Photogenic + 노출 + 태그) (85%)
            await updateProgress(70, '계정 분석 중...');

            // Photogenic 분석
            const photogenicInputs = femaleAccounts.map((a) => ({
                username: a.profile.username,
                profilePicUrl: a.profile.profilePicUrl,
                postImageUrls: a.recentPosts.map((p) => p.imageUrl).filter(Boolean) as string[],
            }));
            const photogenicResults = await analyzePhotogenicBatch(photogenicInputs);

            await updateProgress(78, '계정 상세 분석 중...');

            // 노출 분석
            const exposureResults = await analyzeExposureBatch(photogenicInputs);

            await updateProgress(85, '점수 계산 중...');

            // 태그 확인 및 점수 계산
            const analyzedAccounts: AnalyzedAccount[] = [];

            for (const account of femaleAccounts) {
                const username = account.profile.username;
                const genderResult = genderResults.get(username);
                const photogenicResult = photogenicResults.get(username);
                const exposureResult = exposureResults.get(username);

                // 태그 확인 (caption @멘션 또는 tagged_users)
                let isTagged = false;
                for (const post of account.recentPosts) {
                    if (post.taggedUsers?.includes(targetId) || post.mentionedUsers?.includes(targetId)) {
                        isTagged = true;
                        break;
                    }
                }

                // 커플 사진 감지 결과 확인
                const hasCouplePhoto = photogenicResult?.hasCouplePhoto || false;

                // 점수 계산
                const photogenicGrade = photogenicResult?.photogenicGrade || 1;
                const exposureLevel = exposureResult?.skinVisibility || 'low';

                // 커플 사진이 있으면 위험도 0 (남자친구 있음으로 판단)
                let totalScore: number;
                if (hasCouplePhoto) {
                    totalScore = 0;
                } else {
                    const photogenicScore = getPhotogenicScore(photogenicGrade);
                    const exposureScore = getExposureScore(exposureLevel);
                    const tagScore = isTagged ? TAG_SCORE : 0;
                    totalScore = photogenicScore + exposureScore + tagScore;
                }

                const { status: genderStatus } = classifyGenderStatus(
                    genderResult?.gender || 'unknown',
                    genderResult?.confidence || 0
                );

                analyzedAccounts.push({
                    username,
                    fullName: account.profile.fullName,
                    profilePicUrl: account.profile.profilePicUrl,
                    bio: account.profile.bio,
                    isPrivate: account.profile.isPrivate,
                    gender: genderResult?.gender || 'unknown',
                    genderConfidence: genderResult?.confidence || 0,
                    genderStatus,
                    photogenicGrade,
                    exposureLevel,
                    isTagged,
                    totalScore,
                });
            }

            // Step 8: 위험순위 분류 (95%)
            await updateProgress(92, '위험순위 분류 중...');

            // 점수순 정렬
            analyzedAccounts.sort((a, b) => b.totalScore - a.totalScore);

            // 위험순위 부여
            const rankedAccounts = analyzedAccounts.map((account, index) => ({
                ...account,
                rank: index + 1,
                riskGrade: classifyRiskGrade(index + 1, analyzedAccounts.length),
            }));

            // Step 9: 결과 저장 (100%)
            await updateProgress(95, '결과 저장 중...');

            // 모든 여성 계정 저장
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
                    progress: 100,
                    progress_step: '분석 완료!',
                    completed_at: new Date().toISOString(),
                })
                .eq('id', requestId);

            // 이메일 알림 발송
            if (analysisRequest.users?.email) {
                await sendAnalysisCompleteEmail(
                    analysisRequest.users.email,
                    targetId,
                    requestId
                );
            }

            return NextResponse.json({ success: true, requestId });
        } catch (pipelineError) {
            const rawMessage = pipelineError instanceof Error ? pipelineError.message : 'Unknown error';

            // 사용자 친화적 에러 메시지 변환
            let errorMessage = rawMessage;
            if (rawMessage.includes('SCRAPING_AUTH_ERROR')) {
                errorMessage = '서비스 인증 오류가 발생했습니다. 잠시 후 다시 시도해주세요. 문제가 지속되면 관리자에게 문의해주세요.';
                console.error('SCRAPING_AUTH_ERROR:', rawMessage);
            } else if (rawMessage.includes('SCRAPING_ERROR')) {
                errorMessage = '데이터 수집 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
                console.error('SCRAPING_ERROR:', rawMessage);
            }

            await supabaseAdmin
                .from('analysis_requests')
                .update({
                    status: 'failed',
                    error_message: errorMessage,
                })
                .eq('id', requestId);

            throw pipelineError;
        }
    } catch (error) {
        console.error('Analysis pipeline error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Pipeline failed' },
            { status: 500 }
        );
    }
}
