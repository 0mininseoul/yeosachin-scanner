import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
    RESULT_CURSOR_VERSION,
    RESULT_PAGE_SIZE_DEFAULT,
    RESULT_PAGE_SIZE_MAX,
    ResultPaginationError,
    decodeResultCursor,
    encodeResultCursor,
    paginateAnalysisResults,
    type ResultListKind,
} from '../../../../../lib/domain/analysis/result-pagination';

interface Candidate {
    candidateId: string;
    rank: number;
    evidence: string;
}

function candidate(index: number, rank = index): Candidate {
    return {
        candidateId: `candidate-${String(index).padStart(3, '0')}`,
        rank,
        evidence: `private-evidence-${index}`,
    };
}

function page(
    items: readonly Candidate[],
    list: ResultListKind,
    cursor?: string | null,
    pageSize?: number
) {
    return paginateAnalysisResults(items, {
        list,
        direction: 'asc',
        sortKeyType: 'number',
        getSortKey: item => item.rank,
        getCandidateId: item => item.candidateId,
        cursor,
        pageSize,
    });
}

function rawCursor(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('paginateAnalysisResults', () => {
    it('uses 24 rows by default and walks a large list without duplicates', () => {
        const items = Array.from({ length: 905 }, (_, index) => candidate(index + 1)).reverse();
        const collected: string[] = [];
        let cursor: string | null | undefined;

        do {
            const result = page(items, 'public', cursor);
            collected.push(...result.items.map(item => item.candidateId));
            expect(result.pageSize).toBe(RESULT_PAGE_SIZE_DEFAULT);
            cursor = result.nextCursor;
        } while (cursor);

        expect(collected).toHaveLength(905);
        expect(new Set(collected)).toHaveLength(905);
        expect(collected[0]).toBe('candidate-001');
        expect(collected.at(-1)).toBe('candidate-905');
    });

    it('uses candidate id as a deterministic ascending tie-breaker', () => {
        const items = [
            candidate(3, 1),
            candidate(1, 1),
            candidate(2, 1),
            candidate(4, 2),
        ];

        expect(page(items, 'public', null, 2).items.map(item => item.candidateId)).toEqual([
            'candidate-001',
            'candidate-002',
        ]);

        const descending = paginateAnalysisResults(items, {
            list: 'private',
            direction: 'desc',
            sortKeyType: 'number',
            getSortKey: item => item.rank,
            getCandidateId: item => item.candidateId,
            pageSize: RESULT_PAGE_SIZE_MAX,
        });
        expect(descending.items.map(item => item.candidateId)).toEqual([
            'candidate-004',
            'candidate-001',
            'candidate-002',
            'candidate-003',
        ]);
    });

    it('continues from the ordering tuple even if the cursor row was deleted', () => {
        const items = [candidate(1), candidate(2), candidate(3), candidate(4)];
        const first = page(items, 'public', null, 2);
        const withoutCursorRow = items.filter(item => item.candidateId !== 'candidate-002');
        const second = page(withoutCursorRow, 'public', first.nextCursor, 2);

        expect(second.items.map(item => item.candidateId)).toEqual([
            'candidate-003',
            'candidate-004',
        ]);
    });

    it('accepts at most 50 rows and rejects invalid page sizes or items', () => {
        expect(page([candidate(1)], 'public', null, RESULT_PAGE_SIZE_MAX).pageSize)
            .toBe(RESULT_PAGE_SIZE_MAX);
        for (const invalid of [0, 51, 1.5, Number.NaN]) {
            expect(() => page([candidate(1)], 'public', null, invalid)).toThrowError(
                new ResultPaginationError('INVALID_PAGE_SIZE')
            );
        }

        expect(() => page([candidate(1), candidate(1)], 'public')).toThrowError(
            new ResultPaginationError('INVALID_ITEM')
        );
        expect(() => page([{ ...candidate(1), candidateId: 'raw evidence here' }], 'public'))
            .toThrowError(new ResultPaginationError('INVALID_ITEM'));
    });

    it('rejects malformed, noncanonical, version-mismatched, and extra-field cursors', () => {
        const validPayload = {
            version: RESULT_CURSOR_VERSION,
            list: 'public',
            direction: 'asc',
            sortKeyType: 'number',
            sortKey: 24,
            candidateId: 'candidate-024',
        } as const;

        for (const invalid of [
            'not+padded=',
            Buffer.from('not-json', 'utf8').toString('base64url'),
            rawCursor({ ...validPayload, version: 2 }),
            rawCursor({ ...validPayload, evidence: 'must-not-appear' }),
            rawCursor({ ...validPayload, candidateId: 'unsafe candidate' }),
            rawCursor({
                candidateId: validPayload.candidateId,
                sortKey: validPayload.sortKey,
                sortKeyType: validPayload.sortKeyType,
                list: validPayload.list,
                direction: validPayload.direction,
                version: validPayload.version,
            }),
        ]) {
            expect(() => decodeResultCursor(invalid)).toThrowError(
                new ResultPaginationError('INVALID_CURSOR')
            );
        }
    });

    it('rejects a valid cursor used for another list, direction, or key type', () => {
        const first = page([candidate(1), candidate(2)], 'public', null, 1);
        expect(first.nextCursor).not.toBeNull();

        expect(() => page([candidate(1), candidate(2)], 'private', first.nextCursor, 1))
            .toThrowError(new ResultPaginationError('CURSOR_SCOPE_MISMATCH'));
        expect(() => paginateAnalysisResults([candidate(1)], {
            list: 'public',
            direction: 'desc',
            sortKeyType: 'number',
            getSortKey: item => item.rank,
            getCandidateId: item => item.candidateId,
            cursor: first.nextCursor,
        })).toThrowError(new ResultPaginationError('CURSOR_SCOPE_MISMATCH'));
        expect(() => paginateAnalysisResults([candidate(1)], {
            list: 'public',
            direction: 'asc',
            sortKeyType: 'string',
            getSortKey: item => String(item.rank),
            getCandidateId: item => item.candidateId,
            cursor: first.nextCursor,
        })).toThrowError(new ResultPaginationError('CURSOR_SCOPE_MISMATCH'));
    });

    it('encodes only the ordering tuple and no raw item evidence', () => {
        const result = page([candidate(1), candidate(2)], 'public', null, 1);
        const cursor = result.nextCursor;
        expect(cursor).not.toBeNull();
        const payload = decodeResultCursor(cursor!);
        const decodedJson = Buffer.from(cursor!, 'base64url').toString('utf8');

        expect(payload).toEqual({
            version: RESULT_CURSOR_VERSION,
            list: 'public',
            direction: 'asc',
            sortKeyType: 'number',
            sortKey: 1,
            candidateId: 'candidate-001',
        });
        expect(decodedJson).not.toContain('private-evidence');
        expect(Object.keys(JSON.parse(decodedJson))).toEqual([
            'version',
            'list',
            'direction',
            'sortKeyType',
            'sortKey',
            'candidateId',
        ]);
        expect(encodeResultCursor(payload)).toBe(cursor);
    });
});
