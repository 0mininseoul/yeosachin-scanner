const UNKNOWN_DATE_LABEL = '날짜 미상';

const KST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
});

export function formatKstDateTime(value: unknown): string {
    try {
        const date = value instanceof Date
            ? value
            : typeof value === 'string' || typeof value === 'number'
                ? new Date(value)
                : null;

        if (!date || !Number.isFinite(date.getTime())) return UNKNOWN_DATE_LABEL;
        return KST_DATE_TIME_FORMATTER.format(date);
    } catch {
        return UNKNOWN_DATE_LABEL;
    }
}
