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

    it('hands the heading eyebrow back on every transition that leaves the result sheet', () => {
        const page = readFileSync(join(process.cwd(), 'app/analyze/page.tsx'), 'utf8');

        /**
         * The withdrawal is state, and the sheet only exists on a non-legacy surface, so any
         * transition to the legacy surface unmounts the sheet while `bliteResultShown` is still
         * true. That left the plan screen — a state that is not the result sheet — rendering
         * permanently without its `판독 의뢰서 · 대상 확인` eyebrow.
         *
         * The result CTA is the path that matters most: `onGoToPlans` is what the sheet's
         * `상세 분석 보기` button calls, and it is a direct move to the legacy plan layout.
         */
        const goToPlans = page.slice(
            page.indexOf('const handleGoToPlans = useCallback(() => {'),
        );
        const goToPlansBody = goToPlans.slice(0, goToPlans.indexOf('}, ['));
        expect(goToPlansBody).toContain("setPrecheckoutSurface({ preflightId, surface: 'legacy' });");
        expect(goToPlansBody).toContain('setBliteResultShown(false);');

        // …and the rule is not specific to that one handler: every legacy transition in the file
        // has to hand the eyebrow back, so a new one cannot quietly reintroduce the bug.
        const legacyTransitions = [...page.matchAll(/surface: 'legacy'/g)];
        expect(legacyTransitions.length).toBeGreaterThanOrEqual(2);
        for (const transition of legacyTransitions) {
            const preceding = page.slice(Math.max(0, transition.index - 600), transition.index);
            expect(preceding).toContain('setBliteResultShown(false);');
        }

        // A full target reset restores it too, and nothing else may set it back to true.
        expect(page).toContain('const handleBliteResultShown = useCallback(() => setBliteResultShown(true), []);');
        expect(page.match(/setBliteResultShown\(true\)/g)).toHaveLength(1);
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
