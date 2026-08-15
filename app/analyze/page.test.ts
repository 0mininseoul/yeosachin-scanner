import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    resolveActivePrecheckoutSurface,
} from '@/lib/services/precheckout/blite-page-flow';

describe('/analyze precheckout plan gate', () => {
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

    it('mounts the four-stage flow for an accepted pending preflight before target cards or plans', () => {
        const page = readFileSync(join(process.cwd(), 'app/analyze/page.tsx'), 'utf8');

        expect(page).toContain("preflight?.status === 'pending'");
        expect(page).toContain('preflightId={immersivePreflight.preflightId}');
        expect(page).toContain("activePrecheckoutSurface === 'legacy' && readyPreflight");
        expect(page).toContain("immersiveReleased: activePrecheckoutSurface === 'legacy'");
        expect(page).toContain('data-precheckout-target-card');
    });

    it('resets the viewport to the top on the explicit immersive CTA transition instead of scrolling to plans', () => {
        const page = readFileSync(join(process.cwd(), 'app/analyze/page.tsx'), 'utf8');

        expect(page).not.toContain('planSectionRef.current?.scrollIntoView');
        expect(page).not.toContain('planHeadingRef.current?.focus()');
        expect(page).not.toContain("behavior: 'smooth', block: 'start'");
        expect(page).toContain("window.scrollTo({ top: 0, left: 0, behavior: 'auto' })");
        expect(page).toContain(
            "if (!planGateRequestedRef.current || activePrecheckoutSurface !== 'legacy') return;",
        );
    });
});
