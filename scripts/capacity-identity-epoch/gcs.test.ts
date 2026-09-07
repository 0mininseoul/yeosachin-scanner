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
            response(200, '{"generation":"900719925474099312346"}', { 'x-goog-generation': '900719925474099312346' }),
        ]);
        const storage = new GcsJournalStorage({
            bucket: 'fixture-bucket', transport, tokenProvider: async () => 'fixture-token',
        });
        const found = await storage.get('fixture.json');
        expect(found?.generation).toBe('900719925474099312345');
        expect(found?.value).toEqual({ epoch: 'value' });
        const stored = await storage.put('fixture.json', { next: true }, { ifGenerationMatch: found!.generation });
        expect(stored.generation).toBe('900719925474099312346');
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
});
