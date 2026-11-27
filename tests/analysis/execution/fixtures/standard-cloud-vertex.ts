import { setTimeout as sleep } from 'node:timers/promises';
import type { ApiErrorInfo } from '@google/genai';
export type { GenerateContentConfig, Part } from '@google/genai';
import { vertexDispatchFetch } from '@/lib/services/ai/vertex-dispatch-window';
import { standardModelStage } from './standard-model-stage.mjs';
import { standardObservedModelMs, standardRecoveryDelayScale, syntheticGeneration } from './standard-vertex';

// Build-time substitute for the pinned Node SDK in a QA-only bundle. These are
// the runtime exports read by gemini.ts; no provider SDK is loaded or reachable.
export enum MediaResolution {
    MEDIA_RESOLUTION_UNSPECIFIED = 'MEDIA_RESOLUTION_UNSPECIFIED',
    MEDIA_RESOLUTION_LOW = 'MEDIA_RESOLUTION_LOW',
    MEDIA_RESOLUTION_MEDIUM = 'MEDIA_RESOLUTION_MEDIUM',
    MEDIA_RESOLUTION_HIGH = 'MEDIA_RESOLUTION_HIGH',
}
export enum ThinkingLevel {
    THINKING_LEVEL_UNSPECIFIED = 'THINKING_LEVEL_UNSPECIFIED',
    MINIMAL = 'MINIMAL', LOW = 'LOW', MEDIUM = 'MEDIUM', HIGH = 'HIGH',
}
export class ApiError extends Error {
    readonly status: number;
    constructor(info: ApiErrorInfo) { super(info.message); this.name = 'ApiError'; this.status = info.status; }
}
type Generation = Parameters<typeof syntheticGeneration>[0] & { config: { abortSignal?: AbortSignal } };

export function cloudStandardVertexDelayMs(input: Generation): number {
    const stage = standardModelStage(input);
    // B-lite is precheckout, before the analysis seat is acquired. Its measured
    // latency is unknown; the fixture runs the real preflight work with no artificial delay.
    if (stage === 'preview') return 0;
    const observed = standardObservedModelMs[stage];
    if (observed === undefined) throw new Error('CLOUD_SYNTHETIC_VERTEX_UNCALIBRATED_STAGE');
    // The six-order launch candidate used the same recovery-stress multiplier.
    return observed * standardRecoveryDelayScale;
}

export class GoogleGenAI {
    readonly models;
    constructor(options: { vertexai: boolean; fetch: typeof fetch }) {
        // Reading the supplied getter also satisfies the production SDK transport check.
        const transport = options.fetch;
        if (!options.vertexai || transport !== vertexDispatchFetch) throw new Error('CLOUD_SYNTHETIC_VERTEX_TRANSPORT_REQUIRED');
        this.models = {
            generateContent: async (request: unknown) => {
                // The production SDK accepts many content forms; this fixture supports
                // the Standard generator's content parts and JSON output schemas only.
                const input = request as Generation;
                const delayMs = cloudStandardVertexDelayMs(input);
                const signal = input.config.abortSignal;
                // The real dispatch window authorizes, prepares and marks the send. A
                // constant data URL never puts model input, media or credentials on a wire.
                const response = await transport('data:,standard-cloud-six-vertex', { signal });
                if (!response.ok) throw new Error('CLOUD_SYNTHETIC_VERTEX_TRANSPORT_FAILED');
                await response.arrayBuffer();
                if (delayMs > 0) await sleep(delayMs, undefined, { signal });
                signal?.throwIfAborted();
                try { return syntheticGeneration(input, 'female', 'female', true); }
                catch { throw new Error('CLOUD_SYNTHETIC_VERTEX_FIXTURE_INPUT_INVALID'); }
            },
        };
    }
}
