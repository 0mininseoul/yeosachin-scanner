import { describe, expect, it } from 'vitest';
import {
    generateConciergeBatchHighRiskCopy,
    isRecoverableTargetProfileArtifactError,
    parseConciergeExistingRelationshipArtifacts,
    relationshipArtifactProviderContext,
    type ConciergeBatchHighRiskCopyEvidence,
} from './run-concierge-batch';
import { runConciergeBatch } from '@/lib/services/analysis/concierge-batch-runner';

describe('concierge existing relationship artifact resolver', () => {
    it('accepts only approved callback-free resume identities', () => {
        const artifacts = parseConciergeExistingRelationshipArtifacts(JSON.stringify({
            target_user: {
                followers: {
                    runId: 'Abcdef12',
                    credentialSlot: 'secondary',
                    sourceDeclaredCount: 120,
                },
                following: {
                    runId: 'Zyxwvu98',
                    credentialSlot: 'secondary',
                    sourceDeclaredCount: 80,
                },
            },
        }));

        expect(artifacts.get('target_user')).toEqual({
            followers: {
                runId: 'Abcdef12',
                credentialSlot: 'secondary',
                sourceDeclaredCount: 120,
            },
            following: {
                runId: 'Zyxwvu98',
                credentialSlot: 'secondary',
                sourceDeclaredCount: 80,
            },
        });
        expect(relationshipArtifactProviderContext(
            'request-id',
            artifacts.get('target_user')!.followers!,
            100,
        )).toMatchObject({
            requestId: 'request-id',
            resumeRunId: 'Abcdef12',
            logicalProvider: 'apify',
            actorId: 'scraping_solutions/instagram-scraper-followers-following-no-cookies',
            credentialSlot: 'secondary',
            maxChargeUsd: 100,
            allowAdoptedRelationshipTruncation: true,
            adoptedRelationshipSourceDeclaredCount: 120,
        });
    });

    it('rejects an unapproved or malformed artifact identity', () => {
        expect(() => parseConciergeExistingRelationshipArtifacts(JSON.stringify({
            target_user: {
                followers: {
                    runId: 'bad run id',
                    credentialSlot: 'tertiary',
                    sourceDeclaredCount: 0,
                },
            },
        }))).toThrow('CONCIERGE_BATCH_EXISTING_ARTIFACT_MAP_INVALID');
    });

    it('falls back only for target-profile artifact lineage failures', () => {
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_PROVIDER_ARTIFACT_INVALID'))).toBe(true);
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_PROVIDER_ARTIFACT_LOOKUP_FAILED'))).toBe(true);
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_TARGET_PROFILE_PRIVATE'))).toBe(false);
        expect(isRecoverableTargetProfileArtifactError(new Error('CONCIERGE_PROVIDER_ARTIFACT_INVALID_EXTRA'))).toBe(false);
    });

    const copyEvidence = (facts: ConciergeBatchHighRiskCopyEvidence['facts']): ConciergeBatchHighRiskCopyEvidence => ({
        requestId: '00000000-0000-4000-8000-000000000001',
        targetUsername: 'target_user',
        targetFullName: '대상 이름',
        candidateUsername: 'candidate_user',
        candidateFullName: '후보 이름',
        bio: '여행과 커피를 즐기는 기록',
        captions: ['주말 여행과 커피 기록'],
        appearanceGrade: 4,
        facts,
        images: [],
    });

    it('makes both overview and detail depend on the observed direction', async () => {
        const result = await generateConciergeBatchHighRiskCopy(
            copyEvidence([{ direction: 'candidate_to_target', kind: 'like' }]),
            async prompt => {
                expect(prompt).toContain('후보 이름 -> 대상 이름');
                return {
                    oneLineOverview: '후보 이름이 대상 이름 게시물에 좋아요를 남긴 장면이 먼저 눈에 들어와 흐름이 장난스럽게 번집니다.',
                    riskAnalysis: [
                        '후보 이름이 대상 이름 게시물에 좋아요를 남긴 흐름이 공개 기록의 분위기와 겹쳐 보입니다.',
                        '후보 이름이 대상 이름 게시물에 좋아요를 남긴 사실을 중심으로 두 사람의 장난스러운 결을 읽습니다.',
                    ],
                };
            },
        );
        expect(result.candidateUsername).toBe('candidate_user');
        expect(result.oneLineOverview).toContain('좋아요');
        expect(result.riskAnalysis).toHaveLength(2);
    });

    it('allows provocative no-interaction copy without trust-eroding wording', async () => {
        const result = await generateConciergeBatchHighRiskCopy(
            copyEvidence([]),
            async () => ({
                oneLineOverview: '후보 이름의 여행과 커피 취향이 사진마다 은근한 신호처럼 번져 장난스러운 상상을 부릅니다.',
                riskAnalysis: [
                    '후보 이름의 여행 기록과 커피 장면이 한 편의 가벼운 관계극처럼 이어져 시선을 잡습니다.',
                    '후보 이름의 사진 속 분위기가 평범한 일상보다 조금 더 도발적인 여운을 남깁니다.',
                ],
            }),
        );
        const text = [result.oneLineOverview, ...result.riskAnalysis].join(' ');
        expect(text).not.toMatch(/확인되지 않았다|알 수 없다|수집 범위|공개 자료만으로는/u);
        expect(text).not.toMatch(/좋아요|댓글|태그|멘션/u);
    });

    it('keeps an order retryable after the second copy contract failure', async () => {
        let attempts = 0;
        let publicationCalls = 0;
        let failureCode: string | null = null;
        const summary = await runConciergeBatch([
            {
                orderId: '00000000-0000-4000-8000-000000000002',
                ownerId: '00000000-0000-4000-8000-000000000003',
                targetUsername: 'target_user',
                planId: 'basic',
                cohort: 'awaiting_operator',
            },
        ], {
            async collect() { return null; },
            async classify() { return null; },
            async publish() {
                await generateConciergeBatchHighRiskCopy(
                    copyEvidence([{ direction: 'candidate_to_target', kind: 'comment' }]),
                    async () => {
                        attempts += 1;
                        return { oneLineOverview: '짧음', riskAnalysis: ['짧음', '짧음'] };
                    },
                );
                publicationCalls += 1;
                return { status: 'completed' as const };
            },
            async onFailure(_order, error) {
                failureCode = error instanceof Error ? error.message : null;
            },
        });
        expect(attempts).toBe(2);
        expect(publicationCalls).toBe(0);
        expect(summary).toMatchObject({ total: 1, completed: 0, failed: 1, running: 0 });
        expect(failureCode).toBe('CONCIERGE_BATCH_COPY_GENERATION_FAILED');
    });
});
