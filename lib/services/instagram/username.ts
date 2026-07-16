export const INSTAGRAM_USERNAME_MAX_LENGTH = 30;
export const INSTAGRAM_USERNAME_PATTERN = /^[A-Za-z0-9._]{1,30}$/;
const INSTAGRAM_MENTION_PATTERN = /(^|[^A-Za-z0-9._@])@([A-Za-z0-9._]+)/g;

export function isInstagramUsername(value: unknown): value is string {
    return typeof value === 'string' && INSTAGRAM_USERNAME_PATTERN.test(value);
}

function appendInstagramUsername(
    values: string[],
    seen: Set<string>,
    username: string
): void {
    const normalized = username.trim().toLowerCase();
    if (!isInstagramUsername(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    values.push(normalized);
}

export function extractInstagramMentions(caption?: string): string[] {
    if (!caption) return [];
    const mentions: string[] = [];
    const seen = new Set<string>();
    for (const match of caption.matchAll(INSTAGRAM_MENTION_PATTERN)) {
        appendInstagramUsername(mentions, seen, match[2] ?? '');
    }
    return mentions;
}

export function mergeInstagramMentions(
    parentMentions: readonly string[],
    childCaptions: readonly (string | undefined)[]
): string[] {
    const mentions: string[] = [];
    const seen = new Set<string>();
    for (const username of parentMentions) {
        appendInstagramUsername(mentions, seen, username);
    }
    for (const caption of childCaptions) {
        for (const username of extractInstagramMentions(caption)) {
            appendInstagramUsername(mentions, seen, username);
        }
    }
    return mentions;
}
