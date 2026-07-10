import { describe, expect, it } from 'vitest';
import {
    beginGeminiGeneration,
    clearGeminiGeneration,
    rejectUnresolvedGeminiGeneration,
} from './gemini-generation-intent';

describe('durable Gemini generation intent', () => {
    it('records only bounded operation identity and clears it without changing other state', () => {
        const started = beginGeminiGeneration(
            { analyzeBatchIndex: 2 },
            {
                kind: 'combined',
                operationKey: 'combined:2:0',
                inputIds: ['account_a', 'account_b'],
                now: new Date('2026-07-11T00:00:00.000Z'),
            }
        );

        expect(started.geminiGenerationIntent).toEqual({
            kind: 'combined',
            operationKey: 'combined:2:0',
            inputIds: ['account_a', 'account_b'],
            createdAt: '2026-07-11T00:00:00.000Z',
        });
        expect(clearGeminiGeneration(started)).toEqual({ analyzeBatchIndex: 2 });
    });

    it('fails closed when an earlier invocation left an unresolved intent', () => {
        const started = beginGeminiGeneration({}, {
            kind: 'deep_risk',
            operationKey: 'deep-risk:0',
            inputIds: ['account_a'],
        });

        expect(() => rejectUnresolvedGeminiGeneration(started))
            .toThrow('AI_GENERATION_INTERRUPTED_ERROR');
        expect(() => rejectUnresolvedGeminiGeneration({})).not.toThrow();
    });

    it('rejects invalid or duplicate intent identifiers', () => {
        expect(() => beginGeminiGeneration({}, {
            kind: 'private_names',
            operationKey: 'private names',
            inputIds: ['account_a'],
        })).toThrow('AI_GENERATION_INTENT_CONFIG_ERROR');
        expect(() => beginGeminiGeneration({}, {
            kind: 'private_names',
            operationKey: 'private-names',
            inputIds: ['account_a', 'account_a'],
        })).toThrow('AI_GENERATION_INTENT_CONFIG_ERROR');
    });
});
