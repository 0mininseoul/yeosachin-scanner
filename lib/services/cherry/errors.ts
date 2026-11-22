/** Work that should run again later, or stop for an operator. Codes never contain account data. */
export class CherryDeferError extends Error {
    constructor(
        readonly code: string,
        readonly options: { delaySeconds: number; terminal?: boolean; countAttempt?: boolean },
    ) {
        super(code);
        this.name = 'CherryDeferError';
    }
}

export function cherryErrorCode(error: unknown): string {
    if (error instanceof CherryDeferError) return error.code;
    const code = error instanceof Error ? error.message.match(/^([A-Z][A-Z0-9_]{2,63})(?::|\s|\(|$)/)?.[1] : undefined;
    return code ? code.toLowerCase() : 'unexpected';
}
