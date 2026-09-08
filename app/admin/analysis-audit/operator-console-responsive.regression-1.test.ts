import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./console.css', import.meta.url), 'utf8');

function declarationsFor(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
}

describe('operator console responsive table containment', () => {
    // Regression: ISSUE-001 — wide table overflow escaped its local scroller and moved the mobile page.
    // Found by /qa on 2026-09-08
    // Report: reports/admin-console-verification-20260908/report.md
    it('contains wide table paint inside the horizontal scroller', () => {
        expect(declarationsFor('.oc-table-scroll')).toMatch(/contain:\s*paint/);
    });
});
