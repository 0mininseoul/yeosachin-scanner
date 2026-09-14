import { describe, expect, it } from 'vitest';
import {
    assertSameProject,
    assertSourceBuildMatch,
    collectFullyPaged,
    selectExactResource,
    validateLedgerCoverage,
} from './owner-discovery';
import { EpochError } from './contracts';

const PROJECT = 'fixture-project';

describe('owner production discovery boundaries', () => {
    it('fully consumes exact paginated pages and rejects an incomplete page chain', async () => {
        const pages = new Map<string | undefined, { items: readonly string[]; nextPageToken?: string }>([
            [undefined, { items: ['first'], nextPageToken: 'next' }],
            ['next', { items: ['second'] }],
        ]);
        await expect(collectFullyPaged({ readPage: async token => pages.get(token)! })).resolves.toEqual(['first', 'second']);

        await expect(collectFullyPaged({
            maxPages: 2,
            readPage: async token => ({ items: [token ?? 'first'], nextPageToken: token === undefined ? 'next' : 'last' }),
        })).rejects.toThrow('PAGINATION_INCOMPLETE');
    });

    it('rejects ambiguous exact selectors and mixed-project inventory', () => {
        expect(() => selectExactResource([{ name: 'one' }, { name: 'two' }], () => true)).toThrow(EpochError);
        expect(() => selectExactResource([{ name: 'one' }, { name: 'two' }], item => item.name === 'one')).not.toThrow();
        expect(() => selectExactResource([{ name: 'one' }, { name: 'two' }], () => false)).toThrow('DISCOVERY_AMBIGUOUS');
        expect(() => assertSameProject([{ project: PROJECT }, { project: 'other-project' }], PROJECT, item => item.project)).toThrow('PROJECT_MISMATCH');
    });

    it('fails closed when a fixed zero-work ledger is missing or selector digest drifts', () => {
        expect(() => validateLedgerCoverage(undefined, PROJECT)).toThrow('EVIDENCE_UNAVAILABLE');
        expect(() => validateLedgerCoverage({} as never, PROJECT)).toThrow('EVIDENCE_UNAVAILABLE');
    });

    it('requires source SHA and exact build provenance to agree', () => {
        expect(() => assertSourceBuildMatch({ sourceSha: 'a'.repeat(40), buildSourceSha: 'b'.repeat(40), runtimeSourceSha: 'a'.repeat(40) })).toThrow('SOURCE_INVALID');
        expect(() => assertSourceBuildMatch({ sourceSha: 'a'.repeat(40), buildSourceSha: 'a'.repeat(40), runtimeSourceSha: 'b'.repeat(40) })).toThrow('SOURCE_INVALID');
        expect(() => assertSourceBuildMatch({ sourceSha: 'a'.repeat(40), buildSourceSha: 'a'.repeat(40), runtimeSourceSha: 'a'.repeat(40) })).not.toThrow();
    });
});
