# Landing Traffic Delay Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 랜딩페이지 최상단에 현재 접속 증가로 분석 대기 시간이 지연되고 있음을 알리는 비고정형 운영 배너를 노출한다.

**Architecture:** 기존 `LandingPage`의 `TopBar` 직후에 의미론적 `role="status"` 배너를 인라인으로 추가한다. 별도 상태나 API 없이 정적 운영 문구만 노출하며, 소스 계약 테스트로 배치·문구·비고정형 스타일을 고정한다.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS 4, Vitest

---

### Task 1: 랜딩 지연 배너 계약

**Files:**
- Create: `lib/services/landing/traffic-delay-banner-contract.test.ts`
- Modify: `components/landing-page.tsx`

- [x] **Step 1: 실패하는 계약 테스트 작성**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const landingPage = readFileSync(
    new URL('../../../components/landing-page.tsx', import.meta.url),
    'utf8'
).replace(/\s+/g, ' ');

describe('landing traffic delay banner', () => {
    it('shows a non-sticky status banner immediately after the top bar', () => {
        const topBar = landingPage.indexOf('<TopBar');
        const banner = landingPage.indexOf('data-testid="traffic-delay-banner"');
        const main = landingPage.indexOf('<main');

        expect(landingPage).toContain('현재 접속자가 많아 분석 대기 시간이 평소보다 길어지고 있습니다.');
        expect(landingPage).toContain('role="status"');
        expect(banner).toBeGreaterThan(topBar);
        expect(banner).toBeLessThan(main);
        expect(landingPage).not.toMatch(/data-testid="traffic-delay-banner"[^>]*className="[^"]*(?:fixed|sticky)/);
    });
});
```

- [x] **Step 2: RED 확인**

Run: `npm test -- lib/services/landing/traffic-delay-banner-contract.test.ts`

Expected: 배너 문구 또는 `data-testid`가 없어 FAIL.

- [x] **Step 3: 최소 배너 구현**

`components/landing-page.tsx`에서 `TopBar` 바로 뒤, `<main>` 앞에 다음 구조를 추가한다.

```tsx
<div
  role="status"
  data-testid="traffic-delay-banner"
  className="border-y border-blood/60 bg-blood/15 px-5 py-2.5 text-center text-[13px] font-semibold leading-relaxed text-white"
>
  현재 접속자가 많아 분석 대기 시간이 평소보다 길어지고 있습니다.
</div>
```

- [x] **Step 4: GREEN 확인**

Run: `npm test -- lib/services/landing/traffic-delay-banner-contract.test.ts`

Expected: 1 test passed.

- [x] **Step 5: 관련 정적 검증**

Run: `npm run lint && npx tsc --noEmit && npm run build`

Expected: 모두 exit 0.

- [x] **Step 6: 변경 커밋**

```bash
git add components/landing-page.tsx lib/services/landing/traffic-delay-banner-contract.test.ts docs/superpowers/plans/2026-08-12-landing-traffic-delay-banner.md
git commit -m "feat: show landing traffic delay notice"
```

### Task 2: PR과 프로덕션 검증

**Files:**
- No additional files.

- [ ] **Step 1: 브랜치 푸시와 PR 생성**

Run: `git push -u origin 0mininseoul/landing-traffic-delay-banner-20260812` 후 `gh pr create`.

Expected: 새 PR URL 출력.

- [ ] **Step 2: PR CI 확인 후 머지**

Run: `gh pr checks <PR_NUMBER> --watch` 후 `gh pr merge <PR_NUMBER> --squash`.

Expected: 모든 필수 검사가 pass이고 PR 상태가 MERGED.

- [ ] **Step 3: 프로덕션 확인**

Run: Vercel 배포 상태를 확인하고 `curl -fsSL https://yeosachin.com/` 및 배포 JS 자산에서 공지 문구를 검색한다.

Expected: 랜딩 HTTP 200, Vercel Production Ready, 공지 문구 1건 이상.
