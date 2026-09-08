import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./console.css', import.meta.url), 'utf8');
const workbench = readFileSync(new URL('./workbench.tsx', import.meta.url), 'utf8');

function declarationsFor(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
}

function hexColor(selector: string): string {
    const value = declarationsFor(selector).match(/(?:^|;)\s*color:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(value, `${selector} must use an opaque hex text color`).toBeDefined();
    return value!;
}

function luminance(hex: string): number {
    const channels = hex.slice(1).match(/../g)!.map(value => Number.parseInt(value, 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(foreground: string, background: string): number {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('operator console accessibility contracts', () => {
    // Regression: ISSUE-003 — axe found low-contrast supporting text and a faint focus ring.
    // Found by /qa on 2026-09-08
    // Report: reports/admin-console-verification-20260908/report.md
    it.each([
        ['.oc-muted', '#fffaf8'],
        ['.oc-section-meta', '#fffaf8'],
        ['.oc-role', '#f8fbfd'],
        ['.oc-table thead th', '#ffffff'],
        ['.oc-chip--unknown', '#f3f5f7'],
        ['.oc-stage-name small', '#ffffff'],
        ['.oc-stage-tools .oc-stage-contract', '#fbfcfd'],
        ['.oc-footer', '#eef1f5'],
    ])('keeps %s at WCAG AA text contrast', (selector, background) => {
        expect(contrast(hexColor(selector), background)).toBeGreaterThanOrEqual(4.5);
    });

    it('uses an opaque focus indicator with at least 3:1 contrast on white', () => {
        const focusColor = css.match(/outline:\s*3px solid (#[0-9a-f]{6})/i)?.[1];
        expect(focusColor).toBeDefined();
        expect(contrast(focusColor!, '#ffffff')).toBeGreaterThanOrEqual(3);
    });

    it('keeps the detail heading hierarchy sequential', () => {
        expect(workbench).not.toContain('<h3 id="evidence-title">');
        expect(workbench).toContain('<h2 id="evidence-title">');
    });

    // Regression: ISSUE-003 — the attention region was nested in another region with the same name.
    it('exposes the attention block as one named landmark', () => {
        expect(workbench).toContain('<section className="oc-section oc-section--top" aria-labelledby="attention-title"><AttentionList');
        expect(workbench).not.toContain('return <section className={`oc-attention');
        expect(workbench).toContain('return <div className={`oc-attention');
    });
});
