import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptUrl = new URL(
    './configure-analysis-v2-result-image-r2.sh',
    import.meta.url
);
const scriptPath = fileURLToPath(scriptUrl);
const script = readFileSync(scriptUrl, 'utf8');

function dryRun(overrides: Record<string, string> = {}) {
    return spawnSync('bash', [scriptPath, '--dry-run'], {
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            NODE_ENV: process.env.NODE_ENV ?? 'test',
            CLOUDFLARE_ACCOUNT_ID:
                '0123456789abcdef0123456789abcdef',
            ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET:
                'analysis-v2-result-images',
            ...overrides,
        },
    });
}

describe('analysis V2 result-image R2 configuration script', () => {
    it('defaults to a non-networking, redacted exact plan', () => {
        const result = dryRun({
            CLOUDFLARE_API_TOKEN: 'must-not-be-printed',
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('private Standard R2 bucket');
        expect(result.stdout).toContain('location=apac');
        expect(result.stdout).toContain('managed-r2.dev=disabled');
        expect(result.stdout).toContain('custom-domains=none');
        expect(result.stdout).toContain('prefix=v1/');
        expect(result.stdout).toContain(
            'delete-after-seconds=2592000'
        );
        expect(result.stdout).toContain('exact-rule-count=1');
        expect(result.stdout).toContain(
            'Workers R2 Storage Bucket Item Write'
        );
        expect(result.stdout).toContain(
            'Workers R2 Storage Bucket Item Read'
        );
        expect(result.stdout).not.toContain('must-not-be-printed');
        expect(result.stdout).not.toContain('Authorization');
    });

    it('rejects ambiguous account and bucket targets before any apply', () => {
        expect(dryRun({
            CLOUDFLARE_ACCOUNT_ID: 'not-an-account',
        }).status).not.toBe(0);
        expect(dryRun({
            ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: '../broad-target',
        }).status).not.toBe(0);
    });

    it('fails closed around public access, lifecycle drift, and credentials', () => {
        expect(script).toContain('{"enabled":false}');
        expect(script).toContain('ensure_no_custom_domains');
        expect(script).toContain(
            'existing lifecycle rules require review'
        );
        expect(script).toContain('--reconcile-lifecycle');
        expect(script).toContain('refusing to overwrite existing credential file');
        expect(script).toContain('chmod 600');
        expect(script).toContain('ln "$temp_file" "$file"');
        expect(script).not.toContain('mv "$temp_file" "$file"');
        expect(script).not.toMatch(/printf[^\\n]+CLOUDFLARE_API_TOKEN/);
        expect(script).not.toMatch(/log[^\\n]+token_value/);
    });

    it('uses exact bucket resources and distinct least-privilege tokens', () => {
        expect(script).toContain(
            'com.cloudflare.edge.r2.bucket.${CLOUDFLARE_ACCOUNT_ID}_${R2_JURISDICTION}_${ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET}'
        );
        expect(script).toContain(
            'Workers R2 Storage Bucket Item Write'
        );
        expect(script).toContain(
            'Workers R2 Storage Bucket Item Read'
        );
        expect(script).toContain(
            'writer and reader token names must differ'
        );
        expect(script).toContain(
            'writer and reader credential files must differ'
        );
        expect(script).toContain(
            '.policies[0].resources == {($resource): "*"}'
        );
    });
});
