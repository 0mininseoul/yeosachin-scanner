import { describe, expect, it } from 'vitest';
import { demoArchiveItems } from './archive';

const owner = '123e4567-e89b-42d3-a456-426614174000';
const run = (id: string, startedAt: string | null, createdAt: string) => ({
    id, user_id: owner, target_instagram_id: 'junho_dem' as const,
    fixture_version: 'synthetic-fixture-v1' as const, idempotency_key: `idempotency-key-${id}`,
    duration_seconds: 75, created_at: createdAt, started_at: startedAt,
});

describe('demo archive projection', () => {
    it('excludes unstarted rows, has no failed state, and sorts completed/processing runs newest first', () => {
        const items = demoArchiveItems([
            run('223e4567-e89b-42d3-a456-426614174000', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            run('323e4567-e89b-42d3-a456-426614174000', null, '2026-01-03T00:00:00.000Z'),
            run('423e4567-e89b-42d3-a456-426614174000', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ], new Date('2026-01-02T00:00:30.000Z'));
        expect(items.map(item => item.id)).toEqual([
            '423e4567-e89b-42d3-a456-426614174000',
            '223e4567-e89b-42d3-a456-426614174000',
        ]);
        expect(items.map(item => item.status)).toEqual(['processing', 'completed']);
        expect(items.every(item => item.pipelineVersion === 'v2')).toBe(true);
    });
});
