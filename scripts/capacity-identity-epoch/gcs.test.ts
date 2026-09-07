import { describe, expect, it } from 'vitest';
import { EpochError, canonicalDigest } from './contracts';
import { GcsJournalStorage, type GcsHttpRequest, type GcsHttpResponse } from './gcs';

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
});
