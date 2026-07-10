const TERMINAL_ANALYSIS_STATUSES = new Set(['completed', 'failed']);

export function isAnalysisDeletable(status: string): boolean {
    return TERMINAL_ANALYSIS_STATUSES.has(status);
}
