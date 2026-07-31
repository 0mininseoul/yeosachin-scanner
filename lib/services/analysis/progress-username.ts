/** Canonicalizes and validates a username before any public progress identity use. */
export function canonicalizeAnalysisV2ProgressUsername(rawUsername: string): string {
    const canonicalUsername = rawUsername.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(canonicalUsername)) {
        throw new Error('ANALYSIS_V2_PROGRESS_VALIDATION_ERROR: invalid username.');
    }
    return canonicalUsername;
}
