import { AsyncLocalStorage } from 'node:async_hooks';

const currentAttempt = new AsyncLocalStorage<VertexDispatchWindow>();

/** Carries one audited attempt across asynchronous SDK authentication to fetch. */
export class VertexDispatchWindow {
    private readonly wallDeadline: number;
    private readonly monotonicDeadline: number;
    private sent = false;
    rejectedBeforeSend = false;

    constructor(milliseconds: number) {
        this.wallDeadline = Date.now() + milliseconds;
        this.monotonicDeadline = performance.now() + milliseconds;
    }

    run<T>(operation: () => Promise<T>): Promise<T> {
        return currentAttempt.run(this, operation);
    }

    assertCanStart(): void {
        if (this.sent) throw new Error('VERTEX_ATTEMPT_ALREADY_SENT');
        if (Date.now() >= this.wallDeadline || performance.now() >= this.monotonicDeadline) {
            this.rejectedBeforeSend = true;
            throw new Error('VERTEX_DISPATCH_WINDOW_EXPIRED');
        }
    }

    beginFetch(): void {
        this.assertCanStart();
        this.sent = true;
    }
}

// The pinned Node SDK invokes this at its HTTP boundary, after auth and before
// each network attempt. Other fetch users in the worker retain their own transport.
export const vertexDispatchFetch: typeof fetch = (input, init) => {
    currentAttempt.getStore()?.beginFetch();
    return globalThis.fetch(input, init);
};
