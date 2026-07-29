const forbiddenPersistence = (): never => {
    throw new Error('ANALYSIS_V2_REPLAY_JOB_FORBIDDEN_PERSISTENCE');
};

/**
 * Replay-job build alias for Gemini's optional token-usage persistence edge.
 * The stateless job never calls it; an unexpected call fails closed.
 */
export const supabaseAdmin = new Proxy(Object.freeze({}), {
    get: forbiddenPersistence,
});
