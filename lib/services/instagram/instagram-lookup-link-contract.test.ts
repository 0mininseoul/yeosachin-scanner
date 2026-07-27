import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const componentPath = join(process.cwd(), 'components/instagram-lookup-link.tsx');
const componentSource = existsSync(componentPath)
    ? readFileSync(componentPath, 'utf8').replace(/\s+/g, ' ')
    : '';
const landingSource = readFileSync(join(process.cwd(), 'app/page.tsx'), 'utf8');
const analyzeSource = readFileSync(join(process.cwd(), 'app/analyze/page.tsx'), 'utf8');

describe('Instagram account lookup handoff', () => {
    it('launches the installed Instagram app on iOS and Android', () => {
        expect(componentSource).toContain("const IOS_INSTAGRAM_URL = 'instagram://app'");
        expect(componentSource).toContain(
            "const ANDROID_INSTAGRAM_URL = 'intent://instagram.com/#Intent;scheme=https;package=com.instagram.android;end'"
        );
        expect(componentSource).toContain("navigator.userAgent");
        expect(componentSource).toContain("window.location.assign");
        expect(componentSource).not.toContain('https://www.instagram.com/');
        expect(componentSource).toContain('아이디가 기억 안 나나요?');
        expect(componentSource).toContain('Instagram에서 찾기');
    });

    it('is available below both target account inputs', () => {
        expect(landingSource).toContain('<InstagramLookupLink />');
        expect(analyzeSource).toContain('<InstagramLookupLink />');
    });
});
