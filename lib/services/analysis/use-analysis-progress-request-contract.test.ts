import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'hooks/useAnalysisProgress.ts'), 'utf8');

describe('analysis progress request identity and single-flight contract', () => {
    it('routes queued refetches through the latest request-bound callback', () => {
        expect(source).toContain('const fetchDataRef = useRef<() => Promise<void>>');
        expect(source).toContain('fetchDataRef.current = fetchData;');
        expect(source).toContain('if (shouldRefetch && activeRequestIdRef.current === requestId)');
        expect(source).toContain('void fetchDataRef.current();');
    });

    it('does not render an old request while the next request is loading', () => {
        expect(source).toContain('const currentData = data?.id === requestId ? data : null;');
        expect(source).toContain('const currentOutcome = outcome.requestId === requestId ? outcome : null;');
        expect(source).toContain('loading: currentOutcome?.settled !== true');
    });
});
