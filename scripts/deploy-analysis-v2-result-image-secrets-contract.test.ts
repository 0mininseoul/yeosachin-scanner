import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
    new URL('./deploy-analysis-v2-worker.sh', import.meta.url),
    'utf8'
);

describe('Analysis V2 retained-result-image deployment contract', () => {
    it('pins the three R2 runtime credentials to numeric Secret Manager versions', () => {
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID_SECRET_VERSION'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY_SECRET_VERSION'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET_VERSION'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID_SECRET_ID:$r2_access_key_id_secret_version'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY_SECRET_ID:$r2_secret_access_key_secret_version'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET=$RESULT_IMAGE_OBJECT_HMAC_SECRET_ID:$result_image_object_hmac_secret_version'
        );
    });

    it('deploys only an explicit private Cloudflare endpoint and bucket when enabled', () => {
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGES_ENABLED'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET'
        );
        expect(script).toContain(
            '^https://[a-f0-9]{32}\\.r2\\.cloudflarestorage\\.com$'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGES_ENABLED=$result_images_enabled'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT=$result_image_r2_endpoint'
        );
        expect(script).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET=$result_image_r2_bucket'
        );
    });

    it('rejects both R2 credentials from plaintext runtime manifests', () => {
        expect(script).toContain(
            'IMAGE_PROXY_SIGNING_SECRET|ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID|ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY|APIFY_API_TOKEN'
        );
    });
});
