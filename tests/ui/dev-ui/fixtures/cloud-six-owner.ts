import { vi } from 'vitest';
import registry from '@/config/dev-ui-deployment.json';
import { DEV_UI_APP_ORIGIN } from '@/lib/constants/dev-ui';

export const wave = 'a'.repeat(64);
export function cloudUser(id: string, slot = 1) {
    const email = `dev-six-${wave.slice(0, 16)}-${slot}@example.invalid`;
    return {
        id, email, email_confirmed_at: '2026-11-26T00:00:00Z',
        app_metadata: { provider: 'email', dev_cloud_six_v1: wave, dev_cloud_six_slot: slot },
        identities: [{ provider: 'email', identity_data: { email } }],
    };
}

export function configureCloudWeb() {
    const deployment = registry.deployments[0];
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('DEPLOYMENT_ROLE', 'dev');
    vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
    vi.stubEnv('VERCEL_PROJECT_ID', deployment.vercelProjectId);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', `https://${deployment.supabaseProjectRef}.supabase.co`);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', DEV_UI_APP_ORIGIN);
    vi.stubEnv('DEV_UI_ALLOWED_KAKAO_EMAIL', 'human@example.invalid');
}
