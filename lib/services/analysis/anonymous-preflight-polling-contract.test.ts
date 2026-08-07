import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(
    process.cwd(),
    'hooks/useAnalysisV2Preflight.ts',
), 'utf8');

describe('anonymous preflight polling contract', () => {
    it('does not retry an invalid or expired claim forever', () => {
        expect(source).toContain(
            "response.status === 401 && responseCode === 'UNAUTHORIZED'",
        );
    });
});
