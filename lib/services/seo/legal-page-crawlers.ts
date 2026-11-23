export const LEGAL_PAGE_PATHS = ['/privacy', '/terms'];

const AI_FETCHERS = [
    'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
    'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'Claude-Agent',
    'PerplexityBot', 'Perplexity-User',
    'meta-externalagent', 'meta-externalfetcher', 'CCBot',
];

// Google and Apple publish usage controls separately from their search bots' HTTP identities.
export const AI_ROBOTS_TOKENS = [...AI_FETCHERS, 'Google-Extended', 'Applebot-Extended'];

const aiUserAgent = new RegExp(`(?:^|[^a-z0-9_-])(?:${AI_FETCHERS.join('|')})(?=$|[^a-z0-9_-])`, 'i');

export function isKnownAiFetcher(userAgent: string | null) {
    return userAgent !== null && aiUserAgent.test(userAgent);
}

export function isLegalPagePath(pathname: string) {
    try {
        // Next serves the same page on HTML navigation and App Router data requests.
        const path = decodeURIComponent(pathname).toLowerCase()
            .replace(/\/$/, '')
            .replace(/(?:\.html|(?:\.prefetch)?\.rsc|\.segments\/.*\.segment\.rsc)$/, '');
        return LEGAL_PAGE_PATHS.includes(path);
    } catch {
        return false;
    }
}
