import { AsyncLocalStorage } from 'node:async_hooks';

const currentAttempt = new AsyncLocalStorage<VertexDispatchWindow>();
const currentAuthorization = new AsyncLocalStorage<() => Promise<boolean>>();

export function withVertexDispatchAuthorization<T>(
    authorize: () => Promise<boolean>,
    operation: () => Promise<T>,
): Promise<T> {
    return currentAuthorization.run(authorize, operation);
}

export class VertexDispatchAuthorizationError extends Error {
    constructor(readonly reason: 'closed' | 'unavailable' | 'db_contention') {
        super(reason === 'closed'
            ? 'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH'
            : reason === 'db_contention' ? 'ANALYSIS_V2_AI_CAPACITY_PENDING' : 'ANALYSIS_V2_AI_ATTEMPT_NOT_READY');
        this.name = 'VertexDispatchAuthorizationError';
    }
}

/** Carries one audited attempt across asynchronous SDK authentication to fetch. */
export class VertexDispatchWindow {
    private readonly wallDeadline: number;
    private readonly monotonicDeadline: number;
    private readonly authorize = currentAuthorization.getStore();
    private sent = false;
    private enteredFetch = false;
    rejectedBeforeSend = false;
    authorizationError: VertexDispatchAuthorizationError | null = null;

    constructor(milliseconds: number, private readonly prepare?: () => Promise<void>) {
        this.wallDeadline = Date.now() + milliseconds;
        this.monotonicDeadline = performance.now() + milliseconds;
    }

    run<T>(operation: () => Promise<T>): Promise<T> {
        return currentAttempt.run(this, operation);
    }

    get needsAuthorization(): boolean {
        return this.authorize !== undefined;
    }

    get hasEnteredFetch(): boolean {
        return this.enteredFetch;
    }

    get hasSent(): boolean {
        return this.sent;
    }

    assertCanStart(): void {
        if (this.sent) throw new Error('VERTEX_ATTEMPT_ALREADY_SENT');
        if (this.authorizationError) throw this.authorizationError;
        if (Date.now() >= this.wallDeadline || performance.now() >= this.monotonicDeadline) {
            this.rejectedBeforeSend = true;
            throw new Error('VERTEX_DISPATCH_WINDOW_EXPIRED');
        }
    }

    private assertWireSignal(signal?: AbortSignal | null): void {
        if (signal?.aborted) {
            this.rejectedBeforeSend = true;
            throw new Error('VERTEX_DISPATCH_ABORTED');
        }
    }

    async prepareFetch(signal?: AbortSignal | null): Promise<void> {
        this.assertCanStart();
        this.assertWireSignal(signal);
        if (this.enteredFetch) throw new Error('VERTEX_ATTEMPT_ALREADY_SENT');
        this.enteredFetch = true;
        if (this.authorize) {
            let allowed: boolean;
            try {
                allowed = await this.authorize();
            } catch (error) {
                this.rejectAuthorization(error instanceof VertexDispatchAuthorizationError ? error.reason : 'unavailable');
            }
            this.assertCanStart();
            if (!allowed) this.rejectAuthorization('closed');
            this.assertWireSignal(signal);
            await this.prepare?.();
        }
    }

    markSent(signal?: AbortSignal | null): void {
        this.assertCanStart();
        this.assertWireSignal(signal);
        this.sent = true;
    }

    private rejectAuthorization(reason: VertexDispatchAuthorizationError['reason']): never {
        this.assertCanStart();
        this.rejectedBeforeSend = true;
        this.authorizationError = new VertexDispatchAuthorizationError(reason);
        throw this.authorizationError;
    }
}

// The pinned Node SDK invokes this at its HTTP boundary, after auth and before
// each network attempt. Other fetch users in the worker retain their own transport.
export const vertexDispatchFetch: typeof fetch = async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const attempt = currentAttempt.getStore();
    if (attempt) {
        await attempt.prepareFetch(signal);
        attempt.markSent(signal);
    }
    return globalThis.fetch(input, init);
};
