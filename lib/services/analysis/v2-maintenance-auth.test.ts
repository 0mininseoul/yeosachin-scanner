import { describe, expect, it, vi } from 'vitest';
import {
    getAnalysisV2MaintenanceAuthConfig,
    verifyAnalysisV2MaintenanceAuthorization,
} from './v2-maintenance-auth';

const config = {
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'analysis-maintenance@example-project.iam.gserviceaccount.com',
};

describe('Analysis V2 maintenance OIDC authorization', () => {
    it('parses only a canonical HTTPS origin and service-account email', () => {
        expect(getAnalysisV2MaintenanceAuthConfig({
            ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE: 'https://worker.example.com',
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL:
                'ANALYSIS-MAINTENANCE@example-project.iam.gserviceaccount.com',
        })).toEqual(config);

        expect(() => getAnalysisV2MaintenanceAuthConfig({
            ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE: 'https://worker.example.com/path',
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL:
                config.serviceAccountEmail,
        })).toThrow('invalid OIDC audience');

        expect(() => getAnalysisV2MaintenanceAuthConfig({
            ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE: 'https://worker.example.com:8443',
            ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL:
                config.serviceAccountEmail,
        })).toThrow('invalid OIDC audience');
    });

    it('requires the exact verified maintenance identity and audience', async () => {
        const verifyIdToken = vi.fn().mockResolvedValue({
            getPayload: () => ({
                email: config.serviceAccountEmail,
                email_verified: true,
            }),
        });
        await expect(verifyAnalysisV2MaintenanceAuthorization(
            'Bearer signed-token',
            { config, verifier: { verifyIdToken } }
        )).resolves.toBe(true);
        expect(verifyIdToken).toHaveBeenCalledWith({
            idToken: 'signed-token',
            audience: config.oidcAudience,
        });

        verifyIdToken.mockResolvedValueOnce({
            getPayload: () => ({
                email: 'analysis-task@example-project.iam.gserviceaccount.com',
                email_verified: true,
            }),
        });
        await expect(verifyAnalysisV2MaintenanceAuthorization(
            'Bearer signed-token',
            { config, verifier: { verifyIdToken } }
        )).resolves.toBe(false);
    });
});
