import { describe, expect, it } from 'vitest';
import {
    combinedAnalysisResponseSchema,
    genderAnalysisResponseSchema,
} from './analysis-response-schemas';
import { parseGeminiJsonResponse } from './gemini-response';

describe('parseGeminiJsonResponse', () => {
    it('accepts a valid fenced response through the requested schema', () => {
        const parsed = parseGeminiJsonResponse(
            '```json\n{"gender":"female","confidence":0.9,"reasoning":"evidence"}\n```',
            genderAnalysisResponseSchema
        );
        expect(parsed).toEqual({ gender: 'female', confidence: 0.9, reasoning: 'evidence' });
    });

    it('rejects malformed JSON, enum drift, and out-of-range confidence', () => {
        expect(() => parseGeminiJsonResponse('{bad json}', genderAnalysisResponseSchema))
            .toThrow('invalid JSON');
        expect(() => parseGeminiJsonResponse(
            '{"gender":"other","confidence":0.9,"reasoning":"evidence"}',
            genderAnalysisResponseSchema
        )).toThrow('required analysis schema');
        expect(() => parseGeminiJsonResponse(
            '{"gender":"female","confidence":90,"reasoning":"evidence"}',
            genderAnalysisResponseSchema
        )).toThrow('required analysis schema');
    });

    it('requires all female-only combined fields and rejects unexpected fields', () => {
        expect(() => parseGeminiJsonResponse(
            '{"gender":"female","genderConfidence":0.9,"genderReasoning":"evidence"}',
            combinedAnalysisResponseSchema
        )).toThrow('required analysis schema');
        expect(() => parseGeminiJsonResponse(
            '{"gender":"male","genderConfidence":0.9,"genderReasoning":"evidence","isMarried":false}',
            combinedAnalysisResponseSchema
        )).toThrow('required analysis schema');
    });
});
