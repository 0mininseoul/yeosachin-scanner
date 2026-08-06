import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'components/landing-page.tsx'), 'utf8');

describe('anonymous preflight landing handoff', () => {
    it('keeps landing lead capture while sending every submission to public analyze', () => {
        expect(source).toContain(
            'reportLandingLead({ instagramId: id, rawInput: igId, search: window.location.search });',
        );
        expect(source).toContain("router.push('/analyze?autostart=1');");
        expect(source).not.toMatch(
            /if \(!user\) \{[\s\S]*?setLoginOpen\(true\);[\s\S]*?return;/,
        );
    });
});
