export function anonymousPreflightDeviceId(): string | null {
    if (typeof window === 'undefined') return null;
    try {
        const key = 'analysis:anonymous-device-id';
        const existing = window.localStorage.getItem(key);
        if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
        const generated = window.crypto.randomUUID();
        window.localStorage.setItem(key, generated);
        return generated;
    } catch {
        return null;
    }
}
