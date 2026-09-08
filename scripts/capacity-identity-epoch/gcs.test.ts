import { describe, expect, it } from 'vitest';
import { EpochError, canonicalDigest, type EpochHeader, type EpochTransition } from './contracts';
import { GcsJournalStorage, type GcsHttpRequest, type GcsHttpResponse } from './gcs';
import { EpochJournal } from './journal';

class FakeTransport {
    readonly requests: GcsHttpRequest[] = [];
    private readonly responses: GcsHttpResponse[];

    constructor(responses: GcsHttpResponse[]) {
        this.responses = [...responses];
    }

    async request(request: GcsHttpRequest): Promise<GcsHttpResponse> {
        this.requests.push(request);
        const response = this.responses.shift();
        if (!response) throw new Error('unexpected fake request');
        return response;
    }
}

class InMemoryTransport {
    readonly requests: GcsHttpRequest[] = [];
    private readonly values = new Map<string, { generation: string; body: string }>();
    private generation = 0;

    async request(request: GcsHttpRequest): Promise<GcsHttpResponse> {
        this.requests.push(request);
        const url = new URL(request.url);
        if (request.method === 'POST') {
            const key = url.searchParams.get('name');
            const expected = url.searchParams.get('ifGenerationMatch');
            if (!key || !expected) return response(400, '');
            const current = this.values.get(key);
            if (expected === '0' ? current !== undefined : current?.generation !== expected) return response(412, '');
            const stored = { generation: String(++this.generation), body: request.body ?? '' };
            this.values.set(key, stored);
            return response(200, JSON.stringify({ name: key, generation: stored.generation }), { 'x-goog-generation': stored.generation });
        }
        const objectMarker = '/o/';
        const marker = url.pathname.indexOf(objectMarker);
        if (marker >= 0 && url.pathname !== '/storage/v1/b/fixture-bucket/o') {
            const key = decodeURIComponent(url.pathname.slice(marker + objectMarker.length));
            const current = this.values.get(key);
            if (!current) return response(404, '');
            if (request.method === 'DELETE') {
                const expected = url.searchParams.get('ifGenerationMatch');
                if (expected !== current.generation) return response(412, '');
                this.values.delete(key);
                return response(204, '');
            }
            if (url.searchParams.get('alt') === 'json') {
                return response(200, JSON.stringify({ name: key, generation: current.generation }));
            }
            return response(200, current.body, { 'x-goog-generation': current.generation });
        }
        if (request.method === 'GET') {
            const prefix = url.searchParams.get('prefix') ?? '';
            const items = [...this.values.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([name, value]) => ({ name, generation: value.generation }));
            return response(200, JSON.stringify({ items }));
        }
        return response(400, '');
    }
}

const response = (status: number, body: string, headers: Record<string, string> = {}): GcsHttpResponse => ({
    status, headers, body, url: '',
});

describe('protected GCS journal storage', () => {
    it('uses exact generation preconditions and preserves decimal generations as strings', async () => {
        const transport = new FakeTransport([
            response(200, '{"name":"fixture.json","generation":"900719925474099312345"}', { 'x-goog-generation': '900719925474099312345' }),
            response(200, '{"epoch":"value"}', { 'x-goog-generation': '900719925474099312345' }),
            response(200, '{"name":"fixture.json","generation":"900719925474099312346"}', { 'x-goog-generation': '900719925474099312346' }),
            response(200, '{"name":"fixture.json","generation":"900719925474099312346"}'),
            response(200, '{"next":true}', { 'x-goog-generation': '900719925474099312346' }),
        ]);
        const storage = new GcsJournalStorage({
            bucket: 'fixture-bucket', transport, tokenProvider: async () => 'fixture-token',
        });
        const found = await storage.get('fixture.json');
        expect(found?.generation).toBe('900719925474099312345');
        expect(found?.value).toEqual({ epoch: 'value' });
        const stored = await storage.put('fixture.json', { next: true }, { ifGenerationMatch: found!.generation });
        expect(stored.generation).toBe('900719925474099312346');
        expect(transport.requests[2]?.method).toBe('POST');
        expect(transport.requests[2]?.url).toContain('uploadType=media');
        expect(transport.requests[2]?.url).toContain('ifGenerationMatch=900719925474099312345');
        expect(transport.requests[2]?.headers.authorization).toBe('Bearer fixture-token');
    });

    it('lists every page and reads object media without exposing values in errors', async () => {
        const transport = new FakeTransport([
            response(200, '{"items":[{"name":"epoch/a.json","generation":"1"}],"nextPageToken":"page-2"}'),
            response(200, '{"a":1}', { 'x-goog-generation': '1' }),
            response(200, '{"items":[{"name":"epoch/b.json","generation":"2"}]}'),
            response(200, '{"b":2}', { 'x-goog-generation': '2' }),
        ]);
        const storage = new GcsJournalStorage({
            bucket: 'fixture-bucket', transport, tokenProvider: async () => 'token',
        });
        const entries = await storage.list('epoch/');
        expect(entries.map(entry => entry.key)).toEqual(['epoch/a.json', 'epoch/b.json']);
        expect(entries.map(entry => entry.generation)).toEqual(['1', '2']);
        expect(transport.requests[2]?.url).toContain('pageToken=page-2');
    });

    it('fails closed on redirects, invalid hosts/paths, oversized or malformed responses, and CAS failure', async () => {
        const redirect = new FakeTransport([{
            status: 200, headers: {}, body: '{}', url: 'https://evil.invalid/redirect',
        }]);
        const storage = new GcsJournalStorage({ bucket: 'fixture-bucket', transport: redirect, tokenProvider: async () => 'x' });
        await expect(storage.get('x')).rejects.toThrow('ADAPTER_REDIRECT');

        const malformed = new FakeTransport([response(200, '{not-json}')]);
        const malformedStorage = new GcsJournalStorage({ bucket: 'fixture-bucket', transport: malformed, tokenProvider: async () => 'x' });
        await expect(malformedStorage.list('epoch/')).rejects.toThrow('ADAPTER_RESPONSE_INVALID');

        const cas = new FakeTransport([response(412, '')]);
        const casStorage = new GcsJournalStorage({ bucket: 'fixture-bucket', transport: cas, tokenProvider: async () => 'x' });
        await expect(casStorage.put('epoch.json', {}, { ifGenerationMatch: '1' })).rejects.toThrow('GENERATION_PRECONDITION_FAILED');

        expect(() => new GcsJournalStorage({ bucket: 'fixture/bucket', transport: cas, tokenProvider: async () => 'x' })).toThrow(EpochError);
        expect(canonicalDigest('fixture')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('pins media reads to metadata generations and rejects generation drift', async () => {
        const drift = new FakeTransport([
            response(200, '{"name":"fixture.json","generation":"11"}'),
            response(200, '{"value":1}', { 'x-goog-generation': '12' }),
        ]);
        const storage = new GcsJournalStorage({ bucket: 'fixture-bucket', transport: drift, tokenProvider: async () => 'x' });
        await expect(storage.get('fixture.json')).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
        expect(drift.requests[1]?.url).toContain('generation=11');
    });

    it('rejects malformed pagination, repeated tokens, duplicate keys, and out-of-prefix rows', async () => {
        const malformedToken = new FakeTransport([response(200, '{"items":[],"nextPageToken":7}')]);
        await expect(new GcsJournalStorage({ bucket: 'fixture-bucket', transport: malformedToken, tokenProvider: async () => 'x' }).list('epoch/')).rejects.toThrow('ADAPTER_RESPONSE_INVALID');

        const repeatedToken = new FakeTransport([
            response(200, '{"items":[],"nextPageToken":"same"}'),
            response(200, '{"items":[],"nextPageToken":"same"}'),
        ]);
        await expect(new GcsJournalStorage({ bucket: 'fixture-bucket', transport: repeatedToken, tokenProvider: async () => 'x' }).list('epoch/')).rejects.toThrow('ADAPTER_RESPONSE_INVALID');

        const duplicateKey = new FakeTransport([
            response(200, '{"items":[{"name":"epoch/a.json","generation":"1"}],"nextPageToken":"next"}'),
            response(200, '{"a":1}', { 'x-goog-generation': '1' }),
            response(200, '{"items":[{"name":"epoch/a.json","generation":"1"}]}'),
        ]);
        await expect(new GcsJournalStorage({ bucket: 'fixture-bucket', transport: duplicateKey, tokenProvider: async () => 'x' }).list('epoch/')).rejects.toThrow('ADAPTER_RESPONSE_INVALID');

        const outsidePrefix = new FakeTransport([response(200, '{"items":[{"name":"other/a.json","generation":"1"}]}')]);
        await expect(new GcsJournalStorage({ bucket: 'fixture-bucket', transport: outsidePrefix, tokenProvider: async () => 'x' }).list('epoch/')).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('bounds token acquisition and verifies put read-back content', async () => {
        const timeoutStorage = new GcsJournalStorage({
            bucket: 'fixture-bucket', transport: new FakeTransport([]), tokenProvider: () => new Promise<string>(() => undefined), timeoutMs: 5,
        });
        await expect(timeoutStorage.get('fixture.json')).rejects.toThrow('ADAPTER_TIMEOUT');

        const mismatchedReadback = new FakeTransport([
            response(200, '{"name":"fixture.json","generation":"2"}'),
            response(200, '{"name":"fixture.json","generation":"2"}'),
            response(200, '{"other":true}', { 'x-goog-generation': '2' }),
        ]);
        const storage = new GcsJournalStorage({ bucket: 'fixture-bucket', transport: mismatchedReadback, tokenProvider: async () => 'x' });
        await expect(storage.put('fixture.json', { expected: true }, { ifGenerationMatch: '0' })).rejects.toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('rejects invalid write keys before token acquisition or transport mutation', async () => {
        const requests: GcsHttpRequest[] = [];
        const transport = new FakeTransport([]);
        const storage = new GcsJournalStorage({
            bucket: 'fixture-bucket', transport: {
                request: async request => {
                    requests.push(request);
                    return transport.request(request);
                },
            }, tokenProvider: async () => 'x',
        });
        await expect(storage.put('../outside.json', {}, { ifGenerationMatch: '0' })).rejects.toThrow('ADAPTER_REQUEST_INVALID');
        await expect(storage.put('bad object name', {}, { ifGenerationMatch: '0' })).rejects.toThrow('ADAPTER_REQUEST_INVALID');
        expect(requests).toHaveLength(0);
    });

    it('rechecks the real GCS adapter append intent after a token-await race', async () => {
        const header: EpochHeader = {
            epochIdDigest: '1'.repeat(64), capabilityDigest: '2'.repeat(64),
            oldManifestDigest: '3'.repeat(64), desiredManifestDigest: '4'.repeat(64),
            roleSetDigest: '5'.repeat(64), sourcePlanDigest: '6'.repeat(64),
            createdAt: '2026-09-08T00:00:00.000Z',
        };
        const transport = new InMemoryTransport();
        let pauseNextToken = false;
        let tokenPaused!: () => void;
        const paused = new Promise<void>(resolvePaused => { tokenPaused = resolvePaused; });
        let releaseToken!: () => void;
        const tokenProvider = async (): Promise<string> => {
            if (pauseNextToken) {
                pauseNextToken = false;
                tokenPaused();
                await new Promise<void>(resolveRelease => { releaseToken = resolveRelease; });
            }
            return 'fixture-token';
        };
        const storage = new GcsJournalStorage({ bucket: 'fixture-bucket', transport, tokenProvider });
        const journal = new EpochJournal(storage, { header, now: () => 1_000, leaseMs: 60_000 });
        const lease = await journal.acquire('a'.repeat(64));
        const transition = (proofDigest: string): EpochTransition => ({
            sequence: 1, epochIdDigest: header.epochIdDigest, fromState: null, toState: 'PREPARED', stateVersion: 1,
            lockFence: lease.lock.lockFence, preconditionDigest: '7'.repeat(64), mutationDigest: '8'.repeat(64),
            postconditionDigest: '9'.repeat(64), proofDigest, nativeConcurrencyTokenDigest: 'a'.repeat(64),
            resourceObservationDigest: 'b'.repeat(64), resultCode: 'OK', recordedAt: '2026-09-08T00:00:01.000Z',
        });
        pauseNextToken = true;
        const staleAppend = journal.append(lease, transition('c'.repeat(64)));
        await paused;
        await journal.append(lease, transition('d'.repeat(64)));
        releaseToken();
        await expect(staleAppend).rejects.toThrow('JOURNAL_INVALID');
        const state = await journal.readValidatedState(lease);
        expect(state.state).toBe('PREPARED');
        const journalPosts = transport.requests.filter(request => request.method === 'POST'
            && request.url.includes('epoch-journal'));
        expect(journalPosts).toHaveLength(1);
        expect(journalPosts[0]?.body).toContain('"proofDigest":"' + 'd'.repeat(64) + '"');
        expect(journalPosts[0]?.body).not.toContain('"proofDigest":"' + 'c'.repeat(64) + '"');
    });
});
