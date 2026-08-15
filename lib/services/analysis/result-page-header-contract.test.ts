import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const resultPage = readFileSync(
    join(process.cwd(), 'app', 'result', '[requestId]', 'page.tsx'),
    'utf8',
);

describe('result page subject-header contract', () => {
    it('renders the canonical subject headline and safe Instagram link before either v1 or v2 summary', () => {
        const subjectHeaderStart = resultPage.indexOf('{/* result subject header */}');
        const pipelineSummaryStart = resultPage.indexOf('{/* pipeline-specific summary */}');
        const subjectHeader = resultPage.slice(subjectHeaderStart, pipelineSummaryStart);

        // This placement is the legacy-v1 regression boundary: v1 does not enter
        // the v2 summary branch, so the subject lockup must be shared before it.
        expect(subjectHeaderStart).toBeGreaterThan(-1);
        expect(subjectHeaderStart).toBeLessThan(pipelineSummaryStart);
        expect(subjectHeader).toContain('{targetHeader.displayName}');
        expect(subjectHeader).toContain('님의 위장 여사친');
        expect(subjectHeader).toContain('href={targetHeader.instagramUrl}');
        expect(subjectHeader).toContain('@{targetHeader.username}');
        expect(subjectHeader).toContain('target="_blank"');
        expect(subjectHeader).toContain('rel="noopener noreferrer"');

        // The header owns the only subject hero. Version-specific sections should
        // supply only their verdict and breakdown content, never a second header.
        expect((resultPage.match(/\n\s*님의 위장 여사친\n/g) ?? [])).toHaveLength(1);
    });
});
