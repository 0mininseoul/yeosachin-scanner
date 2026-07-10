export function instagramTimestampMs(value: unknown): number {
    if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
            if (milliseconds <= 8_640_000_000_000_000) return milliseconds;
        }
    }

    if (typeof value !== 'string') return Number.NEGATIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function normalizeInstagramTimestamp(value: unknown): string {
    const milliseconds = instagramTimestampMs(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';
}
