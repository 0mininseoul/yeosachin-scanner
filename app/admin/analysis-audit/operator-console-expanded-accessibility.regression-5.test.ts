import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./console.css', import.meta.url), 'utf8');
const workbench = readFileSync(new URL('./workbench.tsx', import.meta.url), 'utf8');

describe('expanded risk ledger accessibility', () => {
    // Regression: ISSUE-005 — expanding a risk formula exposed h4 headings directly below h2.
    // Found by /qa on 2026-09-08
    // Report: reports/admin-console-verification-20260908/report.md
    it('keeps risk-ledger subheadings sequential and styles their semantic level', () => {
        expect(workbench).not.toContain('<h4>기여도 원장');
        expect(workbench).not.toContain('<h4>점수 전이 · 영구 보관</h4>');
        expect(workbench).toContain('<h3>기여도 원장');
        expect(workbench).toContain('<h3>점수 전이 · 영구 보관</h3>');
        expect(css).toContain('.oc-ledger-grid h3 {');
    });
});
