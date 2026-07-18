import { describe, expect, it, vi } from 'vitest';
import { clearLoginTerminalState } from './login-terminal-state';

function createStorage() {
    const values = new Map<string, string>();
    return {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
}

describe('terminal login cleanup', () => {
    it('keeps pending state on a normal login landing', () => {
        const storage = createStorage();
        storage.setItem('amplitude_auth_started', 'marker');
        storage.setItem('pending_ig', 'target');

        expect(clearLoginTerminalState(false, storage)).toBe(false);
        expect(storage.getItem('amplitude_auth_started')).toBe('marker');
        expect(storage.getItem('pending_ig')).toBe('target');
    });

    it('clears auth and target markers without receiving provider error details', () => {
        const storage = createStorage();
        storage.setItem('amplitude_auth_started', 'marker');
        storage.setItem('pending_ig', 'target');

        expect(clearLoginTerminalState(true, storage)).toBe(true);
        expect(storage.getItem('amplitude_auth_started')).toBeNull();
        expect(storage.getItem('pending_ig')).toBeNull();
    });

    it('fails open when browser storage is unavailable', () => {
        const storage = {
            getItem: vi.fn(),
            removeItem: vi.fn(() => {
                throw new Error('unavailable');
            }),
            setItem: vi.fn(),
        };

        expect(() => clearLoginTerminalState(true, storage)).not.toThrow();
    });
});
