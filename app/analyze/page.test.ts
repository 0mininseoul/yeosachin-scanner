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
        expect(page).toContain('data-precheckout-target-card');
    });

    it('resumes an authenticated exact-match OAuth checkout continuation without the immersive gate, and hides the demo during hydration', () => {
        const page = readFileSync(join(process.cwd(), 'app/analyze/page.tsx'), 'utf8');

        expect(page).not.toContain('immersiveReleased');
        expect(page).toContain(
            'const autoCheckoutTransitionVisible = Boolean(user)\n        && (autoCheckoutUiPending || queryCheckoutPlan !== null);',
        );
        expect(page).toContain("setPrecheckoutSurface({ preflightId, surface: 'legacy' });");
        expect(page.indexOf("setPrecheckoutSurface({ preflightId, surface: 'legacy' });"))
            .toBeLessThan(page.indexOf('consumeAutoCheckoutContinuation();\n        autoCheckoutRecoveryRequestedRef'));
    });

    it('withdraws the page heading eyebrow while the B-lite result sheet owns the screen', () => {
        const page = readFileSync(join(process.cwd(), 'app/analyze/page.tsx'), 'utf8');

        // The result sheet carries exactly one eyebrow of its own; the page must not add a
        // second one above it.
        expect(page).toContain('onBliteResultShown={handleBliteResultShown}');
        // Referentially stable: an inline arrow would rerun the component's one-shot
        // result-announcement effect on every parent render.
        expect(page).toContain(
            'const handleBliteResultShown = useCallback(() => setBliteResultShown(true), []);',
        );
        expect(page).toContain(
            "{!bliteResultShown && (\n                                    <Eyebrow>{exclusionDecided ? '판독 의뢰서 · 대상 확인' : '판독 의뢰서 · 본인 제외'}</Eyebrow>\n                                )}",
        );
        // Every other state keeps it, and a target reset restores it.
        expect(page).toContain("'판독 의뢰서 · 본인 제외'");
        expect(page).toContain('setBliteResultShown(false);');
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
