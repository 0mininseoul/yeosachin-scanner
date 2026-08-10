import { describe, expect, it } from 'vitest';
import {
    buildGenderRoutingManifest,
    createGenderRoutingCanonicalInputHmac,
    GenderRoutingError,
} from './gender-routing';

const base = {
    planId: 'basic' as const,
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    relationshipCheckpointId: 'checkpoint-1',
    hmacSecret: 'gender-routing-test-secret-at-least-32-characters',
};

function candidate(index: number) {
    return { candidateKey: `candidate:${index}`, profilePicUrl: `https://cdn/${index}`, fullname: `Name ${index}`, imageContentHmac: 'a'.repeat(64) };
}

describe('revenue gender routing', () => {
    it('skips the model and selects every candidate within the plan cap', () => {
        const result = buildGenderRoutingManifest({ ...base, candidates: [candidate(2), candidate(1)] });
        expect(result.modelAttemptedCount).toBe(0);
        expect(result.rows.map(row => row.candidateKey)).toEqual(['candidate:1', 'candidate:2']);
        expect(result.rows.every(row => row.selected)).toBe(true);
    });

    it('uses deterministic buckets, 80/20 quotas, and never emits input PII', () => {
        const candidates = Array.from({ length: 120 }, (_, index) => candidate(index));
        const assessments = new Map(candidates.map((row, index) => [row.candidateKey, {
            femaleScore: index < 100 ? 0.8 : 0.1,
            maleScore: index < 100 ? 0.1 : 0.8,
            uncertaintyScore: 0.1,
            evidence: 'image_and_name' as const,
        }]));
        const input = { ...base, candidates, assessments };
        const first = buildGenderRoutingManifest(input);
        const second = buildGenderRoutingManifest(input);
        expect(first.rows).toEqual(second.rows);
        expect(first.selectedCount).toBe(100);
        expect(first.selectedBucketCounts.female_priority).toBe(100);
        expect(first.rows.filter(row => row.selectionSlot === 'female')).toHaveLength(80);
        expect(first.rows.filter(row => row.selectionSlot === 'fill')).toHaveLength(20);
        expect(JSON.stringify(first)).not.toContain('Name ');
        expect(JSON.stringify(first)).not.toContain('https://cdn');
    });

    it('fails closed when routing model failures exceed ten percent', () => {
        const candidates = Array.from({ length: 101 }, (_, index) => candidate(index));
        expect(() => buildGenderRoutingManifest({ ...base, candidates })).toThrowError(
            new GenderRoutingError('ROUTING_UNAVAILABLE'),
        );
    });

    it('rejects a score triple unless all three bounded scores total one', () => {
        const candidates = Array.from({ length: 101 }, (_, index) => candidate(index));
        const assessments = new Map(candidates.map(row => [row.candidateKey, {
            femaleScore: 0.7,
            maleScore: 0.3,
            uncertaintyScore: 0.3,
            evidence: 'image_and_name' as const,
        }]));

        expect(() => buildGenderRoutingManifest({ ...base, candidates, assessments })).toThrowError(
            new GenderRoutingError('ROUTING_UNAVAILABLE'),
        );
    });

    it('rejects evidence labels that do not match the actual image and name presence', () => {
        const candidates = Array.from({ length: 101 }, (_, index) => candidate(index));
        const assessments = new Map(candidates.map(row => [row.candidateKey, {
            femaleScore: 0.8,
            maleScore: 0.2,
            uncertaintyScore: 0,
            evidence: 'image_only' as const,
        }]));

        expect(() => buildGenderRoutingManifest({ ...base, candidates, assessments })).toThrowError(
            new GenderRoutingError('ROUTING_UNAVAILABLE'),
        );
    });

    it('uses final unresolved candidates over the original attempted population after its one retry', () => {
        const candidates = Array.from({ length: 120 }, (_, index) => candidate(index));
        const initial = new Map(candidates.slice(0, 100).map(row => [row.candidateKey, {
            femaleScore: 0.8,
            maleScore: 0.1,
            uncertaintyScore: 0.1,
            evidence: 'image_and_name' as const,
        }]));
        const retry = new Map(candidates.slice(100).map(row => [row.candidateKey, {
            femaleScore: 0.1,
            maleScore: 0.8,
            uncertaintyScore: 0.1,
            evidence: 'image_and_name' as const,
        }]));

        const result = buildGenderRoutingManifest({
            ...base,
            candidates,
            assessments: initial,
            retryAssessments: retry,
        });

        expect(result.modelRetriedCount).toBe(20);
        expect(result.modelFailedCount).toBe(0);
        expect(result.selectedCount).toBe(100);
    });

    it('allows exactly ten unresolved failed candidates after retry without inflating the denominator', () => {
        const candidates = Array.from({ length: 101 }, (_, index) => candidate(index));
        const initial = new Map(candidates.slice(0, 81).map(row => [row.candidateKey, {
            femaleScore: 0.8,
            maleScore: 0.1,
            uncertaintyScore: 0.1,
            evidence: 'image_and_name' as const,
        }]));
        const retry = new Map(candidates.slice(81, 91).map(row => [row.candidateKey, {
            femaleScore: 0.1,
            maleScore: 0.8,
            uncertaintyScore: 0.1,
            evidence: 'image_and_name' as const,
        }]));

        const result = buildGenderRoutingManifest({
            ...base,
            candidates,
            assessments: initial,
            retryAssessments: retry,
        });

        expect(result.modelAttemptedCount).toBe(101);
        expect(result.modelRetriedCount).toBe(20);
        expect(result.modelFailedCount).toBe(10);
    });

    it('fails closed when one failed retry leaves more than ten percent unresolved on the original denominator', () => {
        const candidates = Array.from({ length: 101 }, (_, index) => candidate(index));
        const initial = new Map(candidates.slice(0, 80).map(row => [row.candidateKey, {
            femaleScore: 0.8,
            maleScore: 0.1,
            uncertaintyScore: 0.1,
            evidence: 'image_and_name' as const,
        }]));
        const retry = new Map(candidates.slice(80, 90).map(row => [row.candidateKey, {
            femaleScore: 0.1,
            maleScore: 0.8,
            uncertaintyScore: 0.1,
            evidence: 'image_and_name' as const,
        }]));

        expect(() => buildGenderRoutingManifest({
            ...base,
            candidates,
            assessments: initial,
            retryAssessments: retry,
        })).toThrowError(new GenderRoutingError('ROUTING_UNAVAILABLE'));
    });

    it('does not count candidates with neither permitted input as failed model calls', () => {
        const candidates = Array.from({ length: 101 }, (_, index) => index === 100
            ? { candidateKey: 'candidate:no-input', profilePicUrl: null, fullname: null }
            : candidate(index));
        const assessments = new Map(candidates.slice(0, 100).map(row => [row.candidateKey, {
            femaleScore: 0.8,
            maleScore: 0.1,
            uncertaintyScore: 0.1,
            evidence: 'image_and_name' as const,
        }]));

        const result = buildGenderRoutingManifest({ ...base, candidates, assessments });

        expect(result.modelAttemptedCount).toBe(100);
        expect(result.modelFailedCount).toBe(0);
        expect(result.rows.find(row => row.candidateKey === 'candidate:no-input')).toMatchObject({
            routingUnavailable: true,
            selected: true,
        });
    });

    it('canonicalizes normalized fullnames and does not treat an unfingerprinted image URL as image evidence', () => {
        const composed = [{
            candidateKey: 'candidate:1',
            profilePicUrl: 'https://images.example/original.jpg',
            fullname: '  Åda\t\nLovelace  ',
            imageContentHmac: 'a'.repeat(64),
        }];
        const decomposed = [{
            candidateKey: 'candidate:1',
            profilePicUrl: 'https://images.example/changed-query.jpg?cache=2',
            fullname: 'A\u030Ada Lovelace',
            imageContentHmac: 'a'.repeat(64),
        }];

        expect(createGenderRoutingCanonicalInputHmac({
            candidates: composed,
            hmacSecret: base.hmacSecret,
        })).toBe(createGenderRoutingCanonicalInputHmac({
            candidates: decomposed,
            hmacSecret: base.hmacSecret,
        }));
        expect(buildGenderRoutingManifest({
            ...base,
            candidates: [{
                candidateKey: 'candidate:missing-image-fingerprint',
                fullname: null,
            }],
        }).rows[0]).toMatchObject({ hasImage: false, evidence: null });
    });
});
