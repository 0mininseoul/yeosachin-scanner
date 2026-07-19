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
