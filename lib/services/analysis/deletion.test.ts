import { describe, expect, it } from 'vitest';
import { isAnalysisDeletable } from './deletion';

describe('isAnalysisDeletable', () => {
    it.each(['completed', 'failed'])('allows terminal status %s', (status) => {
        expect(isAnalysisDeletable(status)).toBe(true);
    });

    it.each(['pending', 'processing', 'unknown'])('rejects non-terminal status %s', (status) => {
        expect(isAnalysisDeletable(status)).toBe(false);
    });
});
