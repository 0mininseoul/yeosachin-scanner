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
                        ? { envs: [{ id: 'env-first', key: 'FIRST', type: 'plain', target: ['production'], gitBranch: null, configurationId: null }], pagination: { next: 17 } }
                        : { envs: [{ id: 'env-second', key: 'SECOND', type: 'plain', target: ['production'], gitBranch: null, configurationId: null }], pagination: { next: null } }),
                };
            },
        };
        const client = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' });
        await expect(readExactVercelProductionEnv({ transport: client, projectId: 'fixture-project', teamId: 'fixture-team' }))
            .resolves.toMatchObject({ keys: ['FIRST', 'SECOND'], count: 2 });
        expect(new URL(requests[1]!).searchParams.get('until')).toBe('17');
    });

    it('keeps allowlisted sensitive metadata without requesting or returning its value', async () => {
        const requests: string[] = [];
        const transport: ProtectedTransport = {
            request: async (request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> => {
                requests.push(request.url);
                return {
                status: 200,
                headers: {},
                url: request.url,
                body: JSON.stringify({ envs: [{ id: 'env-hidden', key: 'HIDDEN', type: 'sensitive', target: ['production'], gitBranch: null, configurationId: null }] }),
                };
            },
        };
        const client = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' });
        await expect(readExactVercelProductionEnvValues({
            transport: client,
            projectId: 'fixture-project',
            teamId: 'fixture-team',
            allowedKeys: new Set(['HIDDEN']),
        })).resolves.toMatchObject({ keys: ['HIDDEN'], sensitiveKeys: ['HIDDEN'], count: 1, values: {} });
        expect(requests).toHaveLength(1);
        expect(new URL(requests[0]!).pathname).toBe('/v9/projects/fixture-project/env');
    });

    it('accepts a unique production membership across multiple targets', async () => {
        const requests: string[] = [];
        const transport: ProtectedTransport = {
            request: async (request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> => {
                requests.push(request.url);
                const url = new URL(request.url);
                if (url.pathname.endsWith('/env')) {
                    expect(url.searchParams.get('target')).toBe('production');
                    return {
                        status: 200,
                        headers: {},
                        url: request.url,
                        body: JSON.stringify({ envs: [{ id: 'env-multi-target', key: 'MULTI_TARGET', type: 'plain', target: ['production', 'preview'], gitBranch: null, configurationId: null }] }),
                    };
                }
                expect(url.pathname).toBe('/v1/projects/fixture-project/env/env-multi-target');
                return {
                    status: 200,
                    headers: {},
                    url: request.url,
                    body: JSON.stringify({ id: 'env-multi-target', key: 'MULTI_TARGET', type: 'plain', target: ['production', 'preview'], gitBranch: null, configurationId: null, value: 'multi-target-value' }),
                };
            },
        };
        const client = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' });
        await expect(readExactVercelProductionEnvValues({
            transport: client,
            projectId: 'fixture-project',
            teamId: 'fixture-team',
            allowedKeys: new Set(['MULTI_TARGET']),
        })).resolves.toMatchObject({ values: { MULTI_TARGET: 'multi-target-value' }, count: 1 });
        expect(requests).toHaveLength(2);
    });

    it('uses inventory metadata to fetch only allowlisted values by id', async () => {
        const requests: string[] = [];
        const transport: ProtectedTransport = {
            request: async (request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> => {
                requests.push(request.url);
                const url = new URL(request.url);
                if (url.pathname.endsWith('/env')) {
                    expect(url.searchParams.get('decrypt')).toBe('false');
                    return {
                        status: 200,
                        headers: {},
                        url: request.url,
                        body: JSON.stringify({ envs: [
                            { id: 'env-project', key: 'PROJECT', type: 'encrypted', target: ['production'], gitBranch: null, configurationId: null, value: 'ciphertext-project' },
                            { id: 'env-plain', key: 'PLAIN', type: 'plain', target: ['production'], gitBranch: null, configurationId: null, value: 'ciphertext-plain' },
                            { id: 'env-unrelated', key: 'UNRELATED', type: 'encrypted', target: ['production'], gitBranch: null, configurationId: null, value: 'unrelated-ciphertext' },
                        ] }),
                    };
                }
                expect(url.pathname).toMatch(/\/env\/env-(project|plain)$/);
                expect(url.searchParams.get('teamId')).toBe('fixture-team');
                expect(url.searchParams.has('decrypt')).toBe(false);
                const key = url.pathname.endsWith('env-project') ? 'PROJECT' : 'PLAIN';
                return {
                    status: 200,
                    headers: {},
                    url: request.url,
                    body: JSON.stringify({ id: url.pathname.endsWith('env-project') ? 'env-project' : 'env-plain', key, type: key === 'PROJECT' ? 'encrypted' : 'plain', target: ['production'], gitBranch: null, configurationId: null, value: key === 'PROJECT' ? 'project-value' : 'plain-value' }),
                };
            },
        };
        const client = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' });
        await expect(readExactVercelProductionEnvValues({
            transport: client,
            projectId: 'fixture-project',
            teamId: 'fixture-team',
            allowedKeys: new Set(['PROJECT', 'PLAIN']),
        })).resolves.toMatchObject({ values: { PROJECT: 'project-value', PLAIN: 'plain-value' } });
        expect(requests).toHaveLength(3);
        expect(requests.some(url => url.includes('env-unrelated'))).toBe(false);
        expect(requests.some(url => new URL(url).searchParams.get('decrypt') === 'true')).toBe(false);
    });

    it('rejects duplicate inventory keys or ids before any value request', async () => {
        let valueRequests = 0;
        const transport: ProtectedTransport = {
            request: async (request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> => {
                if (new URL(request.url).pathname.endsWith('/env')) {
                    return {
                        status: 200,
                        headers: {},
                        url: request.url,
                        body: JSON.stringify({ envs: [
                            { id: 'env-duplicate', key: 'DUPLICATE', type: 'plain', target: ['production'], gitBranch: null, configurationId: null },
                            { id: 'env-duplicate', key: 'OTHER', type: 'plain', target: ['production'], gitBranch: null, configurationId: null },
                        ] }),
                    };
                }
                valueRequests += 1;
                return { status: 200, headers: {}, url: request.url, body: JSON.stringify({}) };
            },
        };
        const client = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' });
        await expect(readExactVercelProductionEnvValues({
            transport: client,
            projectId: 'fixture-project',
            teamId: 'fixture-team',
            allowedKeys: new Set(['DUPLICATE']),
        })).rejects.toThrow('DISCOVERY_AMBIGUOUS');
        expect(valueRequests).toBe(0);
    });

    it.each([
        ['branch scoped', { target: ['production'], gitBranch: 'feature' }],
        ['shared configuration', { target: ['production'], configurationId: 'shared' }],
    ])('rejects %s allowlisted inventory metadata', async (_case, override) => {
        let valueRequests = 0;
        const transport: ProtectedTransport = {
            request: async (request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> => {
                if (new URL(request.url).pathname.endsWith('/env')) {
                    const metadata: Record<string, unknown> = { id: 'env-target', key: 'TARGET', type: 'plain', target: ['production'], gitBranch: null, configurationId: null };
                    Object.assign(metadata, override);
                    return {
                        status: 200,
                        headers: {},
                        url: request.url,
                        body: JSON.stringify({ envs: [metadata] }),
                    };
                }
                valueRequests += 1;
                return { status: 200, headers: {}, url: request.url, body: JSON.stringify({}) };
            },
        };
        const client = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' });
        await expect(readExactVercelProductionEnvValues({
            transport: client,
            projectId: 'fixture-project',
            teamId: 'fixture-team',
            allowedKeys: new Set(['TARGET']),
        })).rejects.toThrow('DISCOVERY_AMBIGUOUS');
        expect(valueRequests).toBe(0);
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
