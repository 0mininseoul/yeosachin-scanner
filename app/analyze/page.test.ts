import { describe, expect, it } from 'vitest';
import {
    resolveActivePrecheckoutSurface,
    resolvePrecheckoutAvailabilitySurface,
} from '@/lib/services/precheckout/blite-page-flow';

describe('/analyze precheckout plan gate', () => {
    it('does not let a B-lite unavailable callback open the legacy plans surface', () => {
        expect(resolvePrecheckoutAvailabilitySurface('awaiting', false)).toBe('awaiting');
        expect(resolvePrecheckoutAvailabilitySurface('preview', false)).toBe('preview');
        expect(resolvePrecheckoutAvailabilitySurface('legacy', false)).toBe('legacy');
    });

    it('permits only a verified B-lite result to reveal the preview surface', () => {
        expect(resolvePrecheckoutAvailabilitySurface('awaiting', true)).toBe('preview');
    });

    it('keeps a prior preflight legacy surface hidden while a new cohort preflight initializes', () => {
        expect(resolveActivePrecheckoutSurface(
            { preflightId: 'previous-preflight', surface: 'legacy' },
            'new-preflight',
        )).toBe('awaiting');
        expect(resolveActivePrecheckoutSurface(
            { preflightId: 'new-preflight', surface: 'legacy' },
            'new-preflight',
        )).toBe('legacy');
    });
});
