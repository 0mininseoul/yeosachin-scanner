import { describe, expect, it } from 'vitest';
import {
    combinedAnalysisResponseSchema,
    genderAnalysisResponseSchema,
} from './analysis-response-schemas';
import {
    GeminiResponseValidationError,
    parseGeminiJsonResponse,
} from './gemini-response';

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

    it('reports only bounded schema paths and issue categories without raw response values', () => {
        const rawSecret = 'private-profile-value';
        let captured: unknown;

        try {
            parseGeminiJsonResponse(JSON.stringify({
                gender: 'female',
                confidence: 90,
                reasoning: rawSecret,
                unexpectedPrivateField: rawSecret,
            }), genderAnalysisResponseSchema);
        } catch (error) {
            captured = error;
        }

        expect(captured).toBeInstanceOf(GeminiResponseValidationError);
        const diagnostics = (captured as GeminiResponseValidationError).diagnostics;
        expect(diagnostics).toEqual({
            category: 'schema_validation',
            issues: [
                { path: 'confidence', code: 'too_big' },
                { path: '$', code: 'unrecognized_keys' },
            ],
            truncated: false,
        });
        expect(JSON.stringify(diagnostics)).not.toContain(rawSecret);
        expect(JSON.stringify(diagnostics)).not.toContain('unexpectedPrivateField');
    });

    it('classifies malformed JSON without retaining response text', () => {
        const rawSecret = 'private-profile-value';
        let captured: unknown;

        try {
            parseGeminiJsonResponse(`{bad json ${rawSecret}}`, genderAnalysisResponseSchema);
        } catch (error) {
            captured = error;
        }

        expect(captured).toBeInstanceOf(GeminiResponseValidationError);
        expect((captured as GeminiResponseValidationError).diagnostics).toEqual({
            category: 'invalid_json',
            issues: [],
            truncated: false,
        });
        expect(JSON.stringify((captured as GeminiResponseValidationError).diagnostics))
            .not.toContain(rawSecret);
    });
});
