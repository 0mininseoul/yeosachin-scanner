import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function optionalSource(relativePath: string): string {
    try {
        return source(relativePath);
    } catch {
        return '';
    }
}

describe('Amplitude caller privacy contract', () => {
    it('uses canonical event constants and snake_case properties only', () => {
        const callers = [
            source('app/page.tsx'),
            source('app/result/[requestId]/page.tsx'),
            source('app/share/[token]/page.tsx'),
            source('components/auth-buttons.tsx'),
        ].join('\n');
        const trackingCalls = callers.match(/trackEvent\([\s\S]*?\);/g)?.join('\n') ?? '';

        expect(callers).not.toMatch(/CLICK_CTA_START|VIEW_RESULT|CLICK_SHARE_KAKAO/);
        expect(trackingCalls).not.toMatch(/femaleCount|instagramId\s*:/);
        expect(callers).toContain('EVENTS.TARGET_SUBMITTED');
        expect(callers).toContain('EVENTS.RESULT_VIEWED');
        expect(callers).toContain('EVENTS.RESULT_SHARED');
        expect(callers).toContain('result_count');
        expect(callers).toContain('share_channel');
    });

    it('never places the raw target in an analyze URL', () => {
        const landing = source('app/page.tsx');
        const analyze = source('app/analyze/page.tsx');

        expect(landing).not.toMatch(/\/analyze\?[^'"`]*target=/);
        expect(analyze).not.toMatch(/[?&]target=/);
        expect(analyze).not.toMatch(/params\.get\(['"]target['"]\)/);
        expect(analyze).toContain("router.replace('/analyze?preflight=");
    });

    it('tracks result sharing only after the share helper confirms a channel', () => {
        for (const page of [
            source('app/result/[requestId]/page.tsx'),
            source('app/share/[token]/page.tsx'),
        ]) {
            expect(page).toMatch(/const shareChannel = await shareResult/);
            expect(page).toMatch(/if \(shareChannel\)[\s\S]*?trackEvent\(EVENTS\.RESULT_SHARED/);
            expect(page).not.toMatch(/trackEvent\(EVENTS\.RESULT_SHARED[\s\S]*?await shareResult/);
        }
    });

    it('uses the shared result request UUID without exposing the share token', () => {
        const shared = source('app/share/[token]/page.tsx');
        expect(shared).toMatch(
            /trackEvent\(EVENTS\.RESULT_VIEWED, \{[\s\S]*?request_id:\s*result\.requestId/,
        );
        expect(shared).toMatch(
            /if \(shareChannel\)[\s\S]*?trackEvent\(EVENTS\.RESULT_SHARED, \{[\s\S]*?request_id:\s*data\.requestId/,
        );
        const trackingCalls = shared.match(/trackEvent\([\s\S]*?\);/g)?.join('\n') ?? '';
        expect(trackingCalls).not.toMatch(/token\s*:/);
    });

    it('deduplicates only mount lifecycle result views at their callers', () => {
        for (const page of [
            source('app/result/[requestId]/page.tsx'),
            source('app/share/[token]/page.tsx'),
        ]) {
            expect(page).toContain('resultViewTrackedRef');
            expect(page).toMatch(
                /if \(!resultViewTrackedRef\.current\)[\s\S]*?resultViewTrackedRef\.current = true;[\s\S]*?trackEvent\(EVENTS\.RESULT_VIEWED/,
            );
        }
    });

    it('binds target handoff to matching owner and preflight, with terminal cleanup', () => {
        const analyze = source('app/analyze/page.tsx');
        const progress = source('app/progress/[requestId]/page.tsx');
        const result = source('app/result/[requestId]/page.tsx');

        expect(analyze).toContain('readPendingAnalysisTargetForPreflight');
        expect(analyze).toContain('readPendingAnalysisTargetForAutostart');
        expect(analyze).toContain('bindPendingAnalysisTarget');
        expect(analyze).toMatch(/ownerId:\s*user\.id/);
        expect(analyze).toMatch(/preflightId:\s*accepted\.preflightId/);
        expect(analyze).not.toContain('readPendingAnalysisTarget(sessionStorage)');
        for (const page of [analyze, progress, result]) {
            expect(page).toContain('clearPendingAnalysisTargetForTerminalState');
        }
    });

    it('uses pending-target cleanup for every real logout caller', () => {
        for (const page of [
            source('app/analyze/page.tsx'),
            source('app/progress/[requestId]/page.tsx'),
            source('app/result/[requestId]/page.tsx'),
        ]) {
            expect(page).toContain('signOutAndClearPendingAnalysisTarget');
            expect(page).not.toContain("fetch('/api/auth/signout'");
        }

        const myPage = source('app/mypage/page.tsx');
        const logoutButton = optionalSource('components/logout-button.tsx');
        const pendingTarget = source('lib/services/pending-analysis-target.ts');

        expect(myPage.startsWith("'use client';")).toBe(false);
        expect(myPage).toContain("import { LogoutButton } from '@/components/logout-button';");
        expect(myPage).toContain('<LogoutButton />');
        expect(myPage).not.toContain('action="/api/auth/signout"');
        expect(logoutButton.startsWith("'use client';")).toBe(true);
        expect(logoutButton).toContain('signOutAndClearPendingAnalysisTarget');
        expect(logoutButton).toContain('availablePendingTargetStorage()');
        expect(logoutButton).toMatch(/if \(signedOut\) router\.push\('\/'\);/);
        expect(logoutButton).toContain(
            'className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"',
        );
        expect(logoutButton).toContain('로그아웃');
        expect(pendingTarget).not.toContain("fetch('/api/auth/signout'");
        expect(pendingTarget).toContain("import('@/lib/supabase/client')");
        expect(pendingTarget).toMatch(
            /markAnalyticsIdentityPending\(\);[\s\S]*?await initAmplitude\(null\);[\s\S]*?markAnalyticsIdentityReady\(\);/,
        );
        expect(pendingTarget).not.toContain('.reset(');
    });

    it('clears terminal login state without sending the error to analytics', () => {
        const login = source('app/login/page.tsx');

        expect(login).toContain('clearLoginTerminalState(Boolean(error)');
        expect(login).not.toContain('trackEvent');
    });
});
