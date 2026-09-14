import { describe, expect, it } from 'vitest';
import {
    assertSameProject,
    assertSourceBuildMatch,
    collectFullyPaged,
    readExactVercelProductionEnv,
    readExactVercelProductionEnvValues,
    selectExactResource,
    validateLedgerCoverage,
} from './owner-discovery';
import { EpochError } from './contracts';
import { AuthenticatedProtectedTransport, type ProtectedHttpRequest, type ProtectedHttpResponse, type ProtectedTransport } from './platform';

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

    it('normalizes null and numeric continuation cursors before reading the next page', async () => {
        const tokens: Array<string | undefined> = [];
        await expect(collectFullyPaged({
            readPage: async token => {
                tokens.push(token);
                return token === undefined
                    ? { items: ['first'], nextPageToken: 17 }
                    : { items: ['second'], nextPageToken: null };
            },
        })).resolves.toEqual(['first', 'second']);
        expect(tokens).toEqual([undefined, '17']);
    });

    it('normalizes Vercel environment cursors before issuing the next request', async () => {
        const requests: string[] = [];
        const transport: ProtectedTransport = {
            request: async (request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> => {
                requests.push(request.url);
                const until = new URL(request.url).searchParams.get('until');
                return {
                    status: 200,
                    headers: {},
                    url: request.url,
                    body: JSON.stringify(until === null
                        ? { envs: [{ key: 'FIRST' }], pagination: { next: 17 } }
                        : { envs: [{ key: 'SECOND' }], pagination: { next: null } }),
                };
            },
        };
        const client = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' });
        await expect(readExactVercelProductionEnv({ transport: client, projectId: 'fixture-project', teamId: 'fixture-team' }))
            .resolves.toMatchObject({ keys: ['FIRST', 'SECOND'], count: 2 });
        expect(new URL(requests[1]!).searchParams.get('until')).toBe('17');
    });

    it('keeps valid hidden sensitive values out of the value map', async () => {
        const transport: ProtectedTransport = {
            request: async (request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> => ({
                status: 200,
                headers: {},
                url: request.url,
                body: JSON.stringify({ envs: [{ key: 'HIDDEN', type: 'sensitive', value: '' }] }),
            }),
        };
        const client = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' });
        await expect(readExactVercelProductionEnvValues({
            transport: client,
            projectId: 'fixture-project',
            teamId: 'fixture-team',
            allowedKeys: new Set(['HIDDEN']),
        })).resolves.toMatchObject({ count: 1, sensitiveKeys: ['HIDDEN'], values: {} });
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
