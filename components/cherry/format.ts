const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false, hourCycle: 'h23',
});

/** Written out by hand because runtimes disagree on whether Korean uses 오전/오후 or AM/PM. */
export function koreanTime(value: string): string {
    const part = Object.fromEntries(parts.formatToParts(new Date(value)).map(item => [item.type, item.value]));
    const hour = Number(part.hour) % 24;
    return `${hour < 12 ? '오전' : '오후'} ${hour % 12 === 0 ? 12 : hour % 12}:${part.minute}`;
}

export function koreanDayTime(value: string): string {
    const part = Object.fromEntries(parts.formatToParts(new Date(value)).map(item => [item.type, item.value]));
    return `${part.month}월 ${part.day}일 ${koreanTime(value)}`;
}
