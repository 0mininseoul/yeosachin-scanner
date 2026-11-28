import { createRequire } from 'node:module';
import { setTimeout as sdkSleep } from 'node:timers/promises';
import { GoogleGenAI } from '@google/genai';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleGenAI as CloudFixture, cloudStandardVertexDelayMs, ApiError as FixtureApiError, ThinkingLevel as FixtureThinking, MediaResolution as FixtureMedia } from '../analysis/execution/fixtures/standard-cloud-vertex';
import { VertexDispatchWindow, vertexDispatchFetch, withVertexDispatchAuthorization } from '@/lib/services/ai/vertex-dispatch-window';

vi.mock('node:timers/promises', { spy: true });

const requireNode = createRequire(import.meta.url);
const commonJS: typeof import('@google/genai') = requireNode('@google/genai');

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe.each([
    { name: 'ESM', SDK: GoogleGenAI },
    { name: 'CommonJS', SDK: commonJS.GoogleGenAI },
])('$name Vertex HTTP dispatch boundary', ({ SDK }) => {
    function client(authorize: () => void, attempts?: number) {
        const authClient = new OAuth2Client();
        vi.spyOn(authClient, 'getRequestHeaders').mockImplementation(async () => {
            authorize();
            return new Headers();
        });
        const options = {
            vertexai: true, project: 'fixture', location: 'global',
            googleAuthOptions: { authClient }, fetch: vertexDispatchFetch,
            httpOptions: { baseUrl: 'https://fixture.invalid', retryOptions: attempts ? { attempts } : undefined },
        };
        return new SDK(options);
    }

    it('blocks the first send when authentication outlives the window', async () => {
        const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('unexpected model send'));
        vi.stubGlobal('fetch', transport);
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const window = new VertexDispatchWindow(1000);
        const authorize = vi.fn(() => { now += 1001; });
        const ai = client(authorize);
        await expect(window.run(() => ai.models.generateContent({
            model: 'gemini-fixture', contents: 'fixture',
        }))).rejects.toThrow('VERTEX_DISPATCH_WINDOW_EXPIRED');
        expect(authorize).toHaveBeenCalledOnce();
        expect(transport).not.toHaveBeenCalled();
        expect(window.rejectedBeforeSend).toBe(true);
    });

    it('sends once even when the SDK retries an HTTP 503', async () => {
        const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 503 }));
        vi.stubGlobal('fetch', transport);
        const window = new VertexDispatchWindow(30_000);
        const ai = client(() => undefined, 2);
        await expect(window.run(() => ai.models.generateContent({
            model: 'gemini-fixture', contents: 'fixture',
        }))).rejects.toThrow('VERTEX_ATTEMPT_ALREADY_SENT');
        expect(transport).toHaveBeenCalledOnce();
        expect(window.rejectedBeforeSend).toBe(false);
    });
});

describe('Dev cloud synthetic Vertex SDK', () => {
    const create = () => new CloudFixture({ vertexai: true, fetch: vertexDispatchFetch });
    const sample = (field: string, text = '', abortSignal?: AbortSignal) => ({
        contents: { parts: [{ text }] }, config: { responseJsonSchema: { properties: { [field]: {} } }, abortSignal },
    });
    it('bundles the actual Gemini caller with only the chosen SDK and no file-based observation loader', async () => {
        const { build } = await import('esbuild');
        const target = './tests/analysis/execution/fixtures/standard-cloud-vertex.ts';
        async function bundle(alias?: Record<string, string>) {
            const { metafile } = await build({ entryPoints: ['lib/services/ai/gemini.ts'],
                bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false, metafile: true, alias });
            return { inputs: Object.keys(metafile.inputs), imports: Object.values(metafile.outputs).flatMap(o => o.imports.map(i => i.path)) };
        }
        const hosted = await bundle();
        expect(hosted.inputs).not.toContain(target.slice(2));
        expect(hosted.imports).toContain('@google/genai/node');
        const fixture = await bundle({ '@google/genai/node': target });
        expect(fixture.inputs).toContain(target.slice(2));
        expect([...fixture.inputs, ...fixture.imports].some(path => path.includes('@google/genai')
            || path.includes('private90-observations') || path.includes('private90-worker-failure'))).toBe(false);
    });
    it('uses the worker SDK exports and runs B-lite immediately through the real dispatch window', async () => {
        expect(FixtureThinking).toEqual(commonJS.ThinkingLevel);
        expect(FixtureMedia).toEqual(commonJS.MediaResolution);
        expect(new FixtureApiError({ message: 'test', status: 429 }).status).toBe(429);
        expect(() => new CloudFixture({ vertexai: true, fetch })).toThrow('TRANSPORT_REQUIRED');
        const order: string[] = [];
        const actual = globalThis.fetch;
        const preview = sample('persona');
        expect(cloudStandardVertexDelayMs(preview)).toBe(0);
        await withVertexDispatchAuthorization(async () => { order.push('authorize'); return true; }, async () => {
            const window = new VertexDispatchWindow(5_000, async () => { order.push('prepare'); });
            vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
                expect(String(url)).toBe('data:,standard-cloud-six-vertex');
                expect(window.hasSent).toBe(true);
                order.push('dispatch');
                return actual(url, init);
            }));
            const response = await window.run(() => create().models.generateContent(preview));
            expect(response.usageMetadata).toEqual({ promptTokenCount: 24, candidatesTokenCount: 12, thoughtsTokenCount: 0, totalTokenCount: 36 });
            expect(JSON.parse(response.text).persona.headline.length).toBeGreaterThan(0);
        });
        expect(order).toEqual(['authorize', 'prepare', 'dispatch']);
    });
    it('preserves feature evidence, recovery triage, and observed stage timings', async () => {
        const mediaManifest = [{ selectionId: 'a', kind: 'profile' }, { selectionId: 'b', kind: 'feed' }];
        const feature = sample('gender', 'evidence(JSON): ' + JSON.stringify({ mediaManifest }));
        const triage = sample('accounts', 'accounts(JSON): ' + JSON.stringify([{ accountId: 'fixture', mediaManifest }]));
        vi.mocked(sdkSleep).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
        const client = create();
        const measured = await client.models.generateContent(feature);
        expect(JSON.parse(measured.text).evidenceSelectionIds.gender).toEqual(['a', 'b']);
        const graded = await client.models.generateContent(triage);
        expect(JSON.parse(graded.text).accounts[0].assessment.confidence).toBe('medium');
        expect(vi.mocked(sdkSleep).mock.calls.slice(-2).map(call => call[0])).toEqual([30_889 * 1.25, 12_226 * 1.25]);
        await expect(client.models.generateContent(sample('unsupported'))).rejects.toThrow('UNCALIBRATED_STAGE');
    });
    it('uses provider-side time for the nominal Plus rehearsal', () => {
        const feature = { ...sample('gender'), model: 'gemini-3.7-flash' };
        const triage = { ...sample('accounts'), model: 'gemini-3.1-flash-lite' };
        const narrative = { ...sample('lines'), model: 'gemini-3-flash-preview' };
        expect(cloudStandardVertexDelayMs(feature, 'plus')).toBe(23_878);
        expect(cloudStandardVertexDelayMs(triage, 'plus')).toBe(3_510);
        expect(cloudStandardVertexDelayMs(narrative, 'plus')).toBe(5_523);
        expect(cloudStandardVertexDelayMs(feature, 'standard')).toBe(30_889 * 1.25);
        expect(cloudStandardVertexDelayMs(sample('persona'), 'plus')).toBe(0);
        expect(() => cloudStandardVertexDelayMs({ ...feature, model: 'other' }, 'plus'))
            .toThrow('UNCALIBRATED_MODEL');
    });
    it('honors refusal before send and cancellation after the simulated send', async () => {
        const wire = vi.fn<typeof fetch>(async () => new Response(''));
        vi.stubGlobal('fetch', wire);
        const input = sample('inferredGender', '사용 가능한 selectionId: post:fixture');
        await withVertexDispatchAuthorization(async () => false, async () => {
            const window = new VertexDispatchWindow(5_000);
            await expect(window.run(() => create().models.generateContent(input))).rejects.toThrow('FENCE_MISMATCH');
            expect(window.hasSent).toBe(false);
        });
        expect(wire).not.toHaveBeenCalled();
        const controller = new AbortController();
        const window = new VertexDispatchWindow(5_000);
        const pending = window.run(() => create().models.generateContent(sample('inferredGender', '', controller.signal)));
        await vi.waitFor(() => expect(window.hasSent).toBe(true));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(wire).toHaveBeenCalledTimes(1);
        expect(wire.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    });
});
