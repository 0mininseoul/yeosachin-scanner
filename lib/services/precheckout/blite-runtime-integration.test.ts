import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('precheckout B-lite runtime integration', () => {
    it('reserves the bounded worker and status-route runtime ceilings', () => {
        const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as {
            functions: Record<string, { maxDuration?: number }>;
        };
        const worker = readFileSync(join(root, 'app/api/analysis/preflight/worker/route.ts'), 'utf8');
        const status = readFileSync(join(root, 'app/api/analysis/precheckout-blite/route.ts'), 'utf8');

        expect(worker).toContain('export const maxDuration = 75;');
        expect(status).toContain('export const maxDuration = 15;');
        expect(vercel.functions['app/api/analysis/preflight/worker/route.ts']?.maxDuration).toBe(75);
        expect(vercel.functions['app/api/analysis/precheckout-blite/route.ts']?.maxDuration).toBe(15);
    });

    it('keeps the repository rollout defaults off', () => {
        const env = readFileSync(join(root, '.env.example'), 'utf8');

        expect(env).toMatch(/^PRECHECKOUT_BLITE_ENABLED=false$/m);
        expect(env).toMatch(/^PRECHECKOUT_BLITE_ROLLOUT_PERCENT=0$/m);
    });
});
