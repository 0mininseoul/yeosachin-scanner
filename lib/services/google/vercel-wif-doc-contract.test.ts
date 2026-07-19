import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(
    new URL('../../../docs/vercel-gcp-wif.md', import.meta.url),
    'utf8'
);

describe('Vercel WIF operations guide contract', () => {
    it('lists every queue setting required by both Vercel task clients', () => {
        const runtimeStart = guide.indexOf('Vercel Production에는 다음 값을 설정한다.');
        const runtimeEnd = guide.indexOf('Vercel 프로젝트 설정에서', runtimeStart);
        const runtimeExample = guide.slice(runtimeStart, runtimeEnd);

        for (const prefix of ['ANALYSIS_V2', 'PREFLIGHT']) {
            for (const suffix of [
                'TASKS_ENABLED',
                'TASKS_PROJECT',
                'TASKS_LOCATION',
                'TASKS_QUEUE',
                'TASKS_TARGET_URL',
                'TASKS_OIDC_AUDIENCE',
                'TASKS_SERVICE_ACCOUNT_EMAIL',
                'TASKS_CALLER_AUTH_MODE',
                'TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL',
            ]) {
                expect(runtimeExample).toContain(`${prefix}_${suffix}=`);
            }
        }
        expect(runtimeExample).toContain('PREFLIGHT_ACCESS_MODE=test_entitlement');
        expect(runtimeExample).toContain('ANALYSIS_TEST_ENTITLEMENTS_ENABLED=true');
        expect(runtimeExample).toContain('ANALYSIS_TEST_ENTITLEMENT_SECRET=');
    });

    it('keeps admission closed until worker, recovery, and canary checks pass', () => {
        const launchSection = guide.slice(guide.indexOf('## 출시 gate 전환 순서'));
        const worker = launchSection.indexOf('ANALYSIS_V2_WORKER_ENABLED=true');
        const recovery = launchSection.indexOf('ANALYSIS_V2_RECOVERY_ENABLED=true');
        const canary = launchSection.indexOf('canary');
        const admission = launchSection.indexOf('ANALYSIS_V2_ADMISSION_ENABLED=true');

        expect(worker).toBeGreaterThanOrEqual(0);
        expect(recovery).toBeGreaterThan(worker);
        expect(canary).toBeGreaterThan(recovery);
        expect(admission).toBeGreaterThan(canary);
    });

    it('documents the signed canary path without opening public admission', () => {
        const canary = guide.slice(guide.indexOf('### 공개 admission 전 signed canary'));
        const commandBlock = (command: string): string => {
            const start = canary.indexOf(command);
            const end = canary.indexOf('```', start);
            return canary.slice(start, end);
        };

        expect(canary).toContain('npm run test-admission:issue');
        expect(canary).toContain('X-Analysis-Test-Admission');
        expect(canary).toContain('npm run test-entitlement:issue');
        expect(canary).toContain('X-Analysis-Test-Entitlement');
        expect(commandBlock('npm run test-admission:issue')).toContain('--confirm-paid-api-call');
        expect(commandBlock('npm run test-entitlement:issue')).toContain('--confirm-paid-api-call');
        expect(canary).toContain('ANALYSIS_V2_ADMISSION_ENABLED=false');
        expect(canary).toContain('서명 domain이 분리');
    });
});
