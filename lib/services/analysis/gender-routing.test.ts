import { describe, expect, it } from 'vitest';
import { buildGenderRoutingManifest, GenderRoutingError } from './gender-routing';

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
            femaleScore: index < 100 ? 0.9 : 0.1,
            maleScore: index < 100 ? 0.1 : 0.9,
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
});
