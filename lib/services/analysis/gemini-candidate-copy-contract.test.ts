import { describe, expect, it } from 'vitest';
import { assertDistinctGeminiCandidateCopyOverviews } from './gemini-candidate-copy-contract';

describe('shared Gemini candidate copy contract', () => {
    it('rejects the deterministic sparse fallback phrase', () => {
        expect(() => assertDistinctGeminiCandidateCopyOverviews([{
            candidateKey: 'candidate-a',
            overview: '사진에서 이야기를 지어내지 않고 이름으로 확인되는 범위만 차분히 읽어봅니다.',
        }])).toThrow('GEMINI_CANDIDATE_COPY_BANNED_TEXT');
    });

    it('rejects materially repeated cross-candidate summaries', () => {
        expect(() => assertDistinctGeminiCandidateCopyOverviews([
            {
                candidateKey: 'candidate-a',
                overview: '여행과 커피 기록이 사진마다 다른 온도로 이어져 장난스러운 호기심을 남깁니다.',
            },
            {
                candidateKey: 'candidate-b',
                overview: '여행과 커피 기록이 사진마다 다른 온도로 이어져 장난스러운 호기심을 남깁니다.',
            },
        ])).toThrow('GEMINI_CANDIDATE_COPY_DUPLICATE');
    });
});
