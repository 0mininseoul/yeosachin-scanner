import { createRequire } from 'node:module';
import { GoogleGenAI } from '@google/genai';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VertexDispatchWindow, vertexDispatchFetch } from '@/lib/services/ai/vertex-dispatch-window';

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
