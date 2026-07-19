# 랜딩 익명 리드 저장 + 로그인 후 프리필 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로그아웃 유저가 랜딩에서 인스타 아이디를 제출해 로그인 모달이 뜨는 시점에 그 아이디를 attribution과 함께 Supabase에 저장하고, 로그인 후 `/analyze`에서 그 아이디를 입력창에 프리필하되 자동 실행 없이 유저 클릭으로만 조회가 시작되게 한다.

**Architecture:** 익명 쓰기는 서버 API Route(`POST /api/leads`)가 오리진/JSON 가드 + zod 검증 후 `supabaseAdmin`(service_role)으로 `landing_leads` 테이블에 insert. 클라는 fire-and-forget으로 호출. 프리필은 기존 `pending-analysis-target`(sessionStorage) 핸드오프를 재사용하고, `/analyze`의 `autostart` 분기에서 자동 `startPreflight` 호출만 제거한다.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase(supabase-js/service_role), zod, vitest.

## Global Constraints

- 테스트 러너: `npx vitest run <path>` (package.json `test` = `vitest run`).
- 마이그레이션 하드닝 스타일은 `supabase/migrations/20260717140000_add_groble_earlybird_presale.sql`과 동일: `extensions.gen_random_uuid()`, `pg_catalog.clock_timestamp()`, `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ... FROM anon, authenticated`, `GRANT ... TO service_role`, 정책 없음.
- HTTP 가드는 `@/lib/services/earlybird/contracts`의 `isSameOriginMutation`·`isJsonRequest`를 **import 재사용**한다. earlybird 파일은 수정하지 않는다(병렬 워크트리 충돌 방지).
- 리드 아이디 정규화 규칙: `pending-analysis-target`의 `TARGET_PATTERN`과 동일 — `^[A-Za-z0-9._]{1,30}$`, 양끝·연속 `.` 금지, 선행 `@` 제거, trim, 소문자화.
- `app/page.tsx`의 마케팅 카피는 수정 금지(CLAUDE.md Project Rule #4). 기능(로직/props)만 추가.
- `autostart=1` 파라미터명과 `readPendingAnalysisTargetForAutostart` 헬퍼명은 유지한다(문자열 매칭 테스트 보존). 동작만 변경.
- 커밋 메시지 말미: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `landing_leads` 마이그레이션 + 계약 테스트

**Files:**
- Create: `supabase/migrations/20260719160000_add_landing_leads.sql`
- Test: `lib/services/leads/landing-leads-migration-contract.test.ts`

**Interfaces:**
- Produces: `public.landing_leads` 테이블(컬럼: `id, instagram_id, raw_input, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer, user_agent, created_at`).

- [ ] **Step 1: 마이그레이션 계약 테스트 작성 (실패)**

```ts
// lib/services/leads/landing-leads-migration-contract.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260719160000_add_landing_leads.sql'),
    'utf8',
);

describe('landing_leads migration', () => {
    it('creates the table with the hardened id and timestamp defaults', () => {
        expect(sql).toContain('CREATE TABLE public.landing_leads');
        expect(sql).toContain('extensions.gen_random_uuid()');
        expect(sql).toContain('pg_catalog.clock_timestamp()');
        expect(sql).toContain('instagram_id TEXT NOT NULL');
    });

    it('locks the table down to service_role only', () => {
        expect(sql).toContain('ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY');
        expect(sql).toContain('REVOKE ALL ON TABLE public.landing_leads FROM anon, authenticated');
        expect(sql).toContain('GRANT INSERT, SELECT ON TABLE public.landing_leads TO service_role');
        expect(sql).not.toMatch(/CREATE POLICY[\s\S]*landing_leads/i);
    });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx vitest run lib/services/leads/landing-leads-migration-contract.test.ts`
Expected: FAIL (파일 없음).

- [ ] **Step 3: 마이그레이션 SQL 작성**

```sql
-- 20260719160000_add_landing_leads.sql
-- 랜딩에서 로그인 벽에 막힌 익명 유저가 제출한 인스타 아이디를 attribution과 함께 수집한다.
-- 클라 접근은 전면 차단하고 service_role(서버 admin)만 기록한다.

CREATE TABLE public.landing_leads (
    id           UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    instagram_id TEXT NOT NULL,
    raw_input    TEXT,
    utm_source   TEXT,
    utm_medium   TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    referrer     TEXT,
    user_agent   TEXT,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX landing_leads_instagram_id_created_at_idx
    ON public.landing_leads(instagram_id, created_at DESC);

ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY;

-- 정책 없음: anon/authenticated 는 접근 불가. service_role 은 RLS 를 우회한다.
REVOKE ALL ON TABLE public.landing_leads FROM anon, authenticated;
GRANT INSERT, SELECT ON TABLE public.landing_leads TO service_role;
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npx vitest run lib/services/leads/landing-leads-migration-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add supabase/migrations/20260719160000_add_landing_leads.sql lib/services/leads/landing-leads-migration-contract.test.ts
git commit -m "feat: add landing_leads table for anonymous lead capture"
```

---

### Task 2: 리드 계약 — 정규화 + zod 스키마

**Files:**
- Create: `lib/services/leads/contracts.ts`
- Test: `lib/services/leads/contracts.test.ts`

**Interfaces:**
- Consumes: `isSameOriginMutation`, `isJsonRequest` from `@/lib/services/earlybird/contracts`.
- Produces:
  - `normalizeLeadInstagramId(value: unknown): string | null`
  - `landingLeadRequestSchema` (zod) → `LandingLeadRequest` = `{ instagramId: string; rawInput?: string; attribution?: { source?: string; medium?: string; campaign?: string; content?: string; term?: string }; referrer?: string }`
  - re-export `isSameOriginMutation`, `isJsonRequest`.

- [ ] **Step 1: 테스트 작성 (실패)**

```ts
// lib/services/leads/contracts.test.ts
import { describe, expect, it } from 'vitest';
import { landingLeadRequestSchema, normalizeLeadInstagramId } from './contracts';

describe('normalizeLeadInstagramId', () => {
    it('strips a leading @, trims, and lowercases', () => {
        expect(normalizeLeadInstagramId('  @Suzy_Kim.02 ')).toBe('suzy_kim.02');
    });
    it('rejects empty, invalid chars, and dot-edge/consecutive-dot forms', () => {
        expect(normalizeLeadInstagramId('')).toBeNull();
        expect(normalizeLeadInstagramId('@')).toBeNull();
        expect(normalizeLeadInstagramId('bad name')).toBeNull();
        expect(normalizeLeadInstagramId('.leading')).toBeNull();
        expect(normalizeLeadInstagramId('trailing.')).toBeNull();
        expect(normalizeLeadInstagramId('double..dot')).toBeNull();
        expect(normalizeLeadInstagramId('a'.repeat(31))).toBeNull();
    });
    it('rejects non-string input', () => {
        expect(normalizeLeadInstagramId(123)).toBeNull();
        expect(normalizeLeadInstagramId(null)).toBeNull();
    });
});

describe('landingLeadRequestSchema', () => {
    it('accepts a minimal body', () => {
        const parsed = landingLeadRequestSchema.safeParse({ instagramId: 'suzy' });
        expect(parsed.success).toBe(true);
    });
    it('accepts attribution + referrer within limits', () => {
        const parsed = landingLeadRequestSchema.safeParse({
            instagramId: 'suzy',
            rawInput: '@Suzy',
            attribution: { source: 'instagram', medium: 'cpc' },
            referrer: 'https://example.com/x',
        });
        expect(parsed.success).toBe(true);
    });
    it('rejects missing instagramId and oversize fields', () => {
        expect(landingLeadRequestSchema.safeParse({}).success).toBe(false);
        expect(landingLeadRequestSchema.safeParse({
            instagramId: 'suzy', rawInput: 'x'.repeat(101),
        }).success).toBe(false);
        expect(landingLeadRequestSchema.safeParse({
            instagramId: 'suzy', referrer: 'x'.repeat(501),
        }).success).toBe(false);
    });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx vitest run lib/services/leads/contracts.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 구현 작성**

```ts
// lib/services/leads/contracts.ts
import { z } from 'zod';
import { isJsonRequest, isSameOriginMutation } from '@/lib/services/earlybird/contracts';

export { isJsonRequest, isSameOriginMutation };

const TARGET_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export function normalizeLeadInstagramId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/^@+/, '').toLowerCase();
    if (!TARGET_PATTERN.test(normalized)) return null;
    if (normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) {
        return null;
    }
    return normalized;
}

const attributionSchema = z.object({
    source: z.string().max(64).optional(),
    medium: z.string().max(64).optional(),
    campaign: z.string().max(64).optional(),
    content: z.string().max(64).optional(),
    term: z.string().max(64).optional(),
}).optional();

export const landingLeadRequestSchema = z.object({
    instagramId: z.string().min(1).max(100),
    rawInput: z.string().max(100).optional(),
    attribution: attributionSchema,
    referrer: z.string().max(500).optional(),
});

export type LandingLeadRequest = z.infer<typeof landingLeadRequestSchema>;
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npx vitest run lib/services/leads/contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add lib/services/leads/contracts.ts lib/services/leads/contracts.test.ts
git commit -m "feat: add landing lead request contract and id normalization"
```

---

### Task 3: 리드 저장소 — `insertLandingLead`

**Files:**
- Create: `lib/services/leads/store.ts`
- Test: `lib/services/leads/store.test.ts`

**Interfaces:**
- Consumes: `supabaseAdmin` from `@/lib/supabase/admin`.
- Produces:
  - `LeadPersistenceError extends Error` (`code: 'LEAD_INSERT_FAILED'`).
  - `insertLandingLead(input: InsertLandingLeadInput): Promise<void>` where
    `InsertLandingLeadInput = { instagramId: string; rawInput?: string; utmSource?: string; utmMedium?: string; utmCampaign?: string; utmContent?: string; utmTerm?: string; referrer?: string; userAgent?: string }`.

- [ ] **Step 1: 테스트 작성 (실패)**

```ts
// lib/services/leads/store.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ insert: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));

import { insertLandingLead, LeadPersistenceError } from './store';

beforeEach(() => {
    mocks.insert.mockReset();
    mocks.from.mockReset();
    mocks.from.mockReturnValue({ insert: mocks.insert });
});

describe('insertLandingLead', () => {
    it('maps input to snake_case columns and inserts once', async () => {
        mocks.insert.mockResolvedValue({ error: null });
        await insertLandingLead({
            instagramId: 'suzy',
            rawInput: '@Suzy',
            utmSource: 'instagram',
            referrer: 'https://x',
            userAgent: 'UA',
        });
        expect(mocks.from).toHaveBeenCalledWith('landing_leads');
        expect(mocks.insert).toHaveBeenCalledWith({
            instagram_id: 'suzy',
            raw_input: '@Suzy',
            utm_source: 'instagram',
            utm_medium: undefined,
            utm_campaign: undefined,
            utm_content: undefined,
            utm_term: undefined,
            referrer: 'https://x',
            user_agent: 'UA',
        });
    });

    it('throws LeadPersistenceError when supabase reports an error', async () => {
        mocks.insert.mockResolvedValue({ error: { message: 'boom' } });
        await expect(insertLandingLead({ instagramId: 'suzy' }))
            .rejects.toBeInstanceOf(LeadPersistenceError);
    });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx vitest run lib/services/leads/store.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 구현 작성**

```ts
// lib/services/leads/store.ts
import { supabaseAdmin } from '@/lib/supabase/admin';

export class LeadPersistenceError extends Error {
    readonly code = 'LEAD_INSERT_FAILED' as const;
    constructor(message: string) {
        super(message);
        this.name = 'LeadPersistenceError';
    }
}

export interface InsertLandingLeadInput {
    instagramId: string;
    rawInput?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    referrer?: string;
    userAgent?: string;
}

export async function insertLandingLead(input: InsertLandingLeadInput): Promise<void> {
    const { error } = await supabaseAdmin.from('landing_leads').insert({
        instagram_id: input.instagramId,
        raw_input: input.rawInput,
        utm_source: input.utmSource,
        utm_medium: input.utmMedium,
        utm_campaign: input.utmCampaign,
        utm_content: input.utmContent,
        utm_term: input.utmTerm,
        referrer: input.referrer,
        user_agent: input.userAgent,
    });
    if (error) {
        throw new LeadPersistenceError(error.message ?? 'landing lead insert failed');
    }
}
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npx vitest run lib/services/leads/store.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add lib/services/leads/store.ts lib/services/leads/store.test.ts
git commit -m "feat: add landing lead persistence via service role"
```

---

### Task 4: `POST /api/leads` 라우트

**Files:**
- Create: `app/api/leads/route.ts`
- Test: `lib/services/leads/leads-route.test.ts`

**Interfaces:**
- Consumes: `landingLeadRequestSchema`, `normalizeLeadInstagramId`, `isSameOriginMutation`, `isJsonRequest` (Task 2); `insertLandingLead`, `LeadPersistenceError` (Task 3).
- Produces: `POST(request: Request): Promise<NextResponse>`.

- [ ] **Step 1: 라우트 테스트 작성 (실패)**

```ts
// lib/services/leads/leads-route.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ insertLandingLead: vi.fn() }));
vi.mock('@/lib/services/leads/store', () => ({
    insertLandingLead: mocks.insertLandingLead,
    LeadPersistenceError: class LeadPersistenceError extends Error {},
}));

import { POST } from '@/app/api/leads/route';

function request(body: unknown, {
    origin = 'https://example.com',
    contentType = 'application/json',
    userAgent = 'UA',
}: { origin?: string | null; contentType?: string | null; userAgent?: string } = {}): Request {
    const headers = new Headers();
    if (origin !== null) headers.set('origin', origin);
    if (contentType !== null) headers.set('content-type', contentType);
    headers.set('user-agent', userAgent);
    return new Request('https://example.com/api/leads', {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

beforeEach(() => {
    mocks.insertLandingLead.mockReset();
    mocks.insertLandingLead.mockResolvedValue(undefined);
});

describe('POST /api/leads', () => {
    it('rejects cross-origin requests with 403', async () => {
        const res = await POST(request({ instagramId: 'suzy' }, { origin: 'https://evil.com' }));
        expect(res.status).toBe(403);
        expect(mocks.insertLandingLead).not.toHaveBeenCalled();
    });

    it('rejects non-JSON with 415', async () => {
        const res = await POST(request({ instagramId: 'suzy' }, { contentType: 'text/plain' }));
        expect(res.status).toBe(415);
    });

    it('rejects invalid body with 400', async () => {
        const res = await POST(request({}, {}));
        expect(res.status).toBe(400);
    });

    it('rejects an un-normalizable instagram id with 400', async () => {
        const res = await POST(request({ instagramId: 'bad name' }, {}));
        expect(res.status).toBe(400);
        expect(mocks.insertLandingLead).not.toHaveBeenCalled();
    });

    it('stores a normalized lead with attribution + user agent and returns 201', async () => {
        const res = await POST(request({
            instagramId: '@Suzy_Kim.02',
            rawInput: '@Suzy_Kim.02',
            attribution: { source: 'instagram', medium: 'cpc' },
            referrer: 'https://ref',
        }, { userAgent: 'MyUA' }));
        expect(res.status).toBe(201);
        expect(mocks.insertLandingLead).toHaveBeenCalledWith(expect.objectContaining({
            instagramId: 'suzy_kim.02',
            rawInput: '@Suzy_Kim.02',
            utmSource: 'instagram',
            utmMedium: 'cpc',
            referrer: 'https://ref',
            userAgent: 'MyUA',
        }));
    });

    it('returns 503 when persistence fails', async () => {
        mocks.insertLandingLead.mockRejectedValue(new Error('down'));
        const res = await POST(request({ instagramId: 'suzy' }, {}));
        expect(res.status).toBe(503);
    });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx vitest run lib/services/leads/leads-route.test.ts`
Expected: FAIL (라우트 없음).

- [ ] **Step 3: 라우트 구현**

```ts
// app/api/leads/route.ts
import { NextResponse } from 'next/server';
import {
    isJsonRequest,
    isSameOriginMutation,
    landingLeadRequestSchema,
    normalizeLeadInstagramId,
} from '@/lib/services/leads/contracts';
import { insertLandingLead } from '@/lib/services/leads/store';

function errorResponse(status: number, code: string, error: string): NextResponse {
    return NextResponse.json({ code, error }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
    if (!isSameOriginMutation(request)) {
        return errorResponse(403, 'FORBIDDEN_ORIGIN', '허용되지 않은 요청입니다.');
    }
    if (!isJsonRequest(request)) {
        return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 요청이 필요합니다.');
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return errorResponse(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }
    const parsed = landingLeadRequestSchema.safeParse(body);
    if (!parsed.success) {
        return errorResponse(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }

    const instagramId = normalizeLeadInstagramId(parsed.data.instagramId);
    if (!instagramId) {
        return errorResponse(400, 'INVALID_REQUEST', '올바른 인스타그램 아이디가 아닙니다.');
    }

    const attribution = parsed.data.attribution ?? {};
    const userAgent = request.headers.get('user-agent')?.slice(0, 500) || undefined;

    try {
        await insertLandingLead({
            instagramId,
            rawInput: parsed.data.rawInput,
            utmSource: attribution.source,
            utmMedium: attribution.medium,
            utmCampaign: attribution.campaign,
            utmContent: attribution.content,
            utmTerm: attribution.term,
            referrer: parsed.data.referrer,
            userAgent,
        });
    } catch {
        return errorResponse(503, 'LEAD_UNAVAILABLE', '잠시 후 다시 시도해주세요.');
    }

    return NextResponse.json({ status: 'stored' }, { status: 201 });
}
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npx vitest run lib/services/leads/leads-route.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add app/api/leads/route.ts lib/services/leads/leads-route.test.ts
git commit -m "feat: add POST /api/leads endpoint for anonymous lead capture"
```

---

### Task 5: 클라이언트 헬퍼 + 랜딩 연결

**Files:**
- Create: `lib/services/landing-lead.ts`
- Test: `lib/services/landing-lead.test.ts`
- Modify: `app/page.tsx` (import 추가; `handleStart`의 `!user` 분기)

**Interfaces:**
- Consumes: `readAttribution` from `@/lib/services/analytics-funnel`.
- Produces: `reportLandingLead(input: { instagramId: string; rawInput: string; search: string }): void` (fire-and-forget).

- [ ] **Step 1: 헬퍼 테스트 작성 (실패)**

```ts
// lib/services/landing-lead.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportLandingLead } from './landing-lead';

describe('reportLandingLead', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
        vi.stubGlobal('document', { referrer: 'https://ref.example' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('POSTs id, raw input, attribution and referrer as JSON', () => {
        reportLandingLead({ instagramId: 'suzy', rawInput: '@Suzy', search: '?utm_source=instagram' });
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toBe('/api/leads');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body.instagramId).toBe('suzy');
        expect(body.rawInput).toBe('@Suzy');
        expect(body.referrer).toBe('https://ref.example');
        expect(body.attribution.source).toBe('instagram');
    });

    it('never throws even if fetch rejects', () => {
        (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
        expect(() => reportLandingLead({ instagramId: 'suzy', rawInput: 'suzy', search: '' }))
            .not.toThrow();
    });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx vitest run lib/services/landing-lead.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 헬퍼 구현**

```ts
// lib/services/landing-lead.ts
import { readAttribution } from './analytics-funnel';

interface ReportLandingLeadInput {
    instagramId: string;
    rawInput: string;
    search: string;
}

// 로그아웃 유저가 로그인 벽에 도달하는 시점에 리드를 기록한다. Fire-and-forget:
// 실패는 삼키고 로그인 흐름을 절대 막지 않는다.
export function reportLandingLead({ instagramId, rawInput, search }: ReportLandingLeadInput): void {
    try {
        const attribution = readAttribution(search);
        const referrer = typeof document !== 'undefined' && document.referrer
            ? document.referrer
            : undefined;
        void fetch('/api/leads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ instagramId, rawInput, attribution, referrer }),
        }).catch(() => { /* best-effort */ });
    } catch {
        /* best-effort */
    }
}
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npx vitest run lib/services/landing-lead.test.ts`
Expected: PASS.

- [ ] **Step 5: `app/page.tsx` 연결**

Import 추가(기존 import 블록에):
```ts
import { reportLandingLead } from '@/lib/services/landing-lead';
```

`handleStart`의 `!user` 분기를 다음과 같이 수정(현재):
```ts
    if (!user) {
      setLoginOpen(true);
      return;
    }
```
변경 후:
```ts
    if (!user) {
      reportLandingLead({ instagramId: id, rawInput: igId, search: window.location.search });
      setLoginOpen(true);
      return;
    }
```
> 마케팅 카피·다른 로직은 건드리지 않는다.

- [ ] **Step 6: 타입/린트 확인 후 커밋**

Run: `npx tsc --noEmit` (또는 `npm run lint`) — 통과 확인.
```bash
git add lib/services/landing-lead.ts lib/services/landing-lead.test.ts app/page.tsx
git commit -m "feat: report landing lead when login wall appears for logged-out users"
```

---

### Task 6: `/analyze` autostart → 프리필 전용 (자동 실행 제거)

**Files:**
- Modify: `app/analyze/page.tsx` (초기화 `useEffect`의 autostart 블록)
- Test: `lib/services/analysis/analyze-autostart-prefill-contract.test.ts`

**Interfaces:**
- Consumes: 없음(파일 소스 문자열 계약 테스트).
- Produces: autostart 분기가 `setInstagramId`(프리필)만 하고 `startPreflight`를 자동 호출하지 않음.

- [ ] **Step 1: 계약 테스트 작성 (실패)**

```ts
// lib/services/analysis/analyze-autostart-prefill-contract.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'app/analyze/page.tsx'), 'utf8');

describe('analyze autostart handoff', () => {
    it('still prefills the target input from the pending handoff', () => {
        expect(source).toContain('readPendingAnalysisTargetForAutostart');
        expect(source).toContain('setInstagramId(pending)');
    });

    it('does not auto-run the paid preflight from the autostart branch', () => {
        // 프리필 전용 마커. autostart 경로에서 자동 startPreflight 호출을 제거했음을 고정한다.
        expect(source).toContain('PREFILL_ONLY_NO_AUTOSTART');
        const autostartCalls = source.match(/startPreflight\(pending\)/g) ?? [];
        expect(autostartCalls.length).toBe(0);
    });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx vitest run lib/services/analysis/analyze-autostart-prefill-contract.test.ts`
Expected: FAIL (마커 없음, `startPreflight(pending)` 존재).

- [ ] **Step 3: `app/analyze/page.tsx` 수정**

현재 초기화 `useEffect`의 아래 블록(대략 150-182행):
```ts
        let pending: string | null = null;
        if (shouldAutostart) {
            try {
                pending = readPendingAnalysisTargetForAutostart(sessionStorage);
            } catch {
                pending = null;
            }
        } else {
            clearPendingAnalysisTarget(sessionStorage);
        }
        if (pending) {
            window.setTimeout(() => setInstagramId(pending), 0);
        }

        if (!shouldAutostart || !pending) return;
        if (!user) {
            router.replace('/login?redirectTo=%2Fanalyze%3Fautostart%3D1');
            return;
        }

        void (async () => {
            const accepted = await startPreflight(pending);
            if (!accepted) {
                clearPendingAnalysisTarget(sessionStorage);
                return;
            }
            bindPendingAnalysisTarget(sessionStorage, {
                ownerId: user.id,
                preflightId: accepted.preflightId,
                target: pending,
            });
            router.replace('/analyze?preflight=' + encodeURIComponent(accepted.preflightId));
        })();
```
아래로 교체(프리필 전용):
```ts
        // PREFILL_ONLY_NO_AUTOSTART: 로그인 후 아이디를 입력창에 채우기만 하고, 유료 preflight
        // 조회는 유저가 "대상 계정 확인하기"를 눌러 handleStartPreflight 가 실행될 때만 시작한다.
        let pending: string | null = null;
        if (shouldAutostart) {
            try {
                pending = readPendingAnalysisTargetForAutostart(sessionStorage);
            } catch {
                pending = null;
            }
        } else {
            clearPendingAnalysisTarget(sessionStorage);
        }
        if (pending) {
            window.setTimeout(() => setInstagramId(pending), 0);
        }

        if (!shouldAutostart || !pending) return;
        if (!user) {
            router.replace('/login?redirectTo=%2Fanalyze%3Fautostart%3D1');
        }
```
> 이 변경으로 `startPreflight`·`bindPendingAnalysisTarget`가 이 `useEffect`에서 더 이상 호출되지 않을 수 있다. 두 함수는 `handleStartPreflight`에서 여전히 쓰이므로 import·구조는 그대로 두되, `npx tsc --noEmit`에서 "사용되지 않음" 경고가 나오면 해당 useEffect 의존성 배열에서 `startPreflight`만 제거한다(다른 참조 유지). 실제 사용 여부는 Step 4에서 확인한다.

- [ ] **Step 4: 테스트 + 타입 확인**

Run: `npx vitest run lib/services/analysis/analyze-autostart-prefill-contract.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: 에러 없음. (의존성 배열의 미사용 참조는 위 지침대로 정리.)

- [ ] **Step 5: 커밋**

```bash
git add app/analyze/page.tsx lib/services/analysis/analyze-autostart-prefill-contract.test.ts
git commit -m "feat: prefill analyze target after login without auto-starting paid preflight"
```

---

### Task 7: 전체 회귀 확인

- [ ] **Step 1: 리드/분석 관련 스위트 실행**

Run: `npx vitest run lib/services/leads lib/services/landing-lead.test.ts lib/services/analysis/analyze-autostart-prefill-contract.test.ts lib/services/analysis/v1-v2-route-isolation.test.ts lib/services/amplitude-caller-contract.test.ts lib/constants/app-url.test.ts lib/services/pending-analysis-target.test.ts`
Expected: 전부 PASS (기존 autostart 문자열 매칭 테스트 포함).

- [ ] **Step 2: 린트/타입**

Run: `npm run lint` 및 `npx tsc --noEmit`
Expected: 통과.

- [ ] **Step 3: 최종 커밋(있으면)**

```bash
git add -A && git commit -m "test: regression pass for landing lead capture + prefill" || echo "nothing to commit"
```

## Self-Review 결과

- 스펙 커버리지: 마이그레이션(T1)·서버 계약/저장/라우트(T2–4)·클라 연결(T5)·프리필 전용(T6)·회귀(T7) 모두 스펙 항목과 1:1 매핑.
- 플레이스홀더: 없음(모든 코드 블록 실제 내용).
- 타입 일관성: `insertLandingLead` 입력 카멜케이스 ↔ 라우트 호출/스토어 매핑, `landingLeadRequestSchema` 필드 ↔ 라우트 참조 일치.
