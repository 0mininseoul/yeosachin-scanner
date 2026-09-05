/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

describe('operator console stage count contract', () => {
    it('uses screened as final-gender declared count when final results exceed initial results', async () => {
        const loaded = await import('./workbench') as unknown as {
            stageSpecs?: (summary: unknown) => Array<{ mode: string; declared: number | null; collected: number | null }>;
        };
        expect(loaded.stageSpecs).toBeDefined();
        if (!loaded.stageSpecs) return;

        const stages = loaded.stageSpecs({
            mutuals: {
                screened: 10,
                declared: 10,
                collected: 10,
                total: 10,
                public: 10,
                private: 0,
                listHash: 'a'.repeat(64),
                keyCoverage: { expected: [], observed: [], missing: [], extra: [], complete: true },
            },
            gender: { initialResolved: 6, finalResolved: 8 },
            interactions: {
                targetLikes: { declared: 0, collected: 0 },
                targetComments: { declared: 0, collected: 0 },
            },
            risk: { declared: 0, collected: 0 },
        });
        expect(stages.find(stage => stage.mode === 'initial')).toMatchObject({ declared: 10, collected: 6 });
        expect(stages.find(stage => stage.mode === 'final')).toMatchObject({ declared: 10, collected: 8 });
    });
});
