import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);

function source(relativePath: string): string {
    const url = new URL(relativePath, root);
    return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

describe('analytics and observability disclosure contract', () => {
    it('discloses the bounded Axiom, Groble, and Amplitude processing actually used', () => {
        const privacy = source('app/privacy/page.tsx');
        const disclosure = privacy.replace(/\s+/g, ' ');

        expect(disclosure).toMatch(/Axiom[^<]*?운영 로그|운영 로그[^<]*?Axiom/);
        expect(disclosure).toMatch(
            /인스타그램 계정 아이디[^<]*?장애[^<]*?진단|장애[^<]*?진단[^<]*?인스타그램 계정 아이디/
        );
        expect(disclosure).toMatch(/Axiom[^<]*?(30일|30 일)|30일[^<]*?Axiom/);
        expect(disclosure).toMatch(/구매자[^<]*?(이름|표시 이름)[^<]*?이메일[^<]*?전화번호/);
        expect(disclosure).toMatch(/결제 매칭[^<]*?결과 제공[^<]*?(분쟁|환불)/);
        expect(disclosure).toMatch(/카드[^<]*?원문 웹훅[^<]*?보관하지/);
        expect(disclosure).toMatch(/Amplitude[^<]*?이용 통계[^<]*?Session Replay[^<]*?비활성화/);
        expect(disclosure).toMatch(/구매자[^<]*?연락처[^<]*?댓글[^<]*?소개글[^<]*?캡션[^<]*?(이미지|미디어) URL[^<]*?제외/);
    });

    it('documents an ingest-only Axiom rollout and a privacy audit before production', () => {
        const operations = source('docs/axiom-observability-operations.md');

        expect(operations).toContain('yeosachin-logs');
        expect(operations).toMatch(/Events/);
        expect(operations).toMatch(/30일/);
        expect(operations).toMatch(/실제 조직 ID[^\n]*UI[^\n]*확인/);
        expect(operations).toMatch(/ingest[^\n]*(전용|만)/i);
        expect(operations).toMatch(/PAT[^\n]*(Vercel|런타임)[^\n]*(금지|사용하지|넣지)/i);
        for (const scenario of ['auth', 'preflight', 'fallback', 'V2 worker', 'Gemini', 'Groble']) {
            expect(operations).toContain(scenario);
        }
        expect(operations).toContain('Yeosachin Operational Health');
        expect(operations).toContain('3개 모니터');
        expect(operations).toContain('environment == "production"');
        expect(operations).toMatch(/notifier[^\n]*(없|미구성)[^\n]*(비활성|disabled)/i);
        expect(operations).toMatch(/토큰 회전/);
    });

    it('documents the closed Amplitude schema with replay disabled and eight event panels', () => {
        const operations = source('docs/amplitude-analytics-operations.md');

        expect(operations).toContain('NEXT_PUBLIC_AMPLITUDE_API_KEY');
        expect(operations).toContain('Supabase UUID');
        expect(operations).toMatch(/Session Replay[^\n]*비활성화/);
        expect(operations).toMatch(/sampleRate[^\n]*0/);
        expect(operations).toContain('얼리버드 전환 대시보드');
        expect(operations.match(/^\d+\. /gm)).toHaveLength(8);
        expect(operations).toMatch(/이벤트 기반[^\n]*이탈/);
        expect(operations).toMatch(/Plus[^\n]*대기 신청[^\n]*(만들지|제외)/);
        expect(operations).toMatch(/Comet[^\n]*UI/);
        expect(operations).toMatch(/금지 (속성|프로퍼티)[^\n]*검사/);
        expect(operations).toMatch(/롤백/);
    });

    it('keeps Axiom runtime variables server-only and excludes provisioning credentials', () => {
        const env = source('.env.example');
        const provisioningCredential = ['AXIOM', 'PERSONAL', 'ACCESS', 'TOKEN'].join('_');
        const publicAxiomPrefix = ['NEXT', 'PUBLIC', 'AXIOM'].join('_');

        expect(env).toContain('AXIOM_TOKEN=');
        expect(env).toContain('AXIOM_DATASET=yeosachin-logs');
        expect(env).toContain('AXIOM_ORG_ID=');
        expect(env).not.toContain(provisioningCredential);
        expect(env).not.toContain(publicAxiomPrefix);
    });
});
