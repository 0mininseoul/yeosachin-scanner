import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createReplayJobGcsClient } from './replay-job-gcs';
import {
    REPLAY_STAGE_FAILURE_DISPOSITIONS,
} from './replay-runner';

const ciphertext = Buffer.from('exact encrypted replay bytes');
const baseConfig = {
    bucket: 'replay-safe-output',
    bundleObject: 'inputs/bundle.enc',
    bundleGeneration: '123456789',
    bundleBytes: ciphertext.byteLength,
    bundleSha256: createHash('sha256').update(ciphertext).digest('hex'),
    claimObject: 'claims/claim-0123456789abcdef.json',
    reportObject: 'reports/report-0123456789abcdef.json',
};

function validTerminalReport(): string {
    const stage = () => ({
        calls: 0,
        rate_limited: 0,
        retries: 0,
        mean_latency_ms: 0,
        p50_latency_ms: 0,
        p95_latency_ms: 0,
        failure_disposition: Object.fromEntries(
            REPLAY_STAGE_FAILURE_DISPOSITIONS.map(
                disposition => [disposition, 0],
            ),
        ),
        failure_kind: {},
    });
    return JSON.stringify({
        status: 'ok',
        benchmark_scope: 'ai-only-historical-partial-available',
        source_plan: 'standard',
        source_pipeline: 'v2',
        source_ai_policy: 'ai-stage-policy-v2.7',
        source_risk_policy: 'risk-policy-v2.3',
        evaluation_ai_policy: 'ai-stage-policy-v2.12',
        replay_ai_policy: 'ai-stage-policy-v2.12',
        full_e2e_evidence: false,
        not_exact: true,
        no_media_substitution: true,
        diagnostic_partial_coverage_override: {
            used: true,
            retained_profiles: 1,
            source_profiles: 1,
            retained_media: 1,
            exact_selected_media: 1,
            profile_retention_bps: 10_000,
            media_retention_bps: 10_000,
        },
        total_elapsed_ms: 0,
        stages: {
            genderTriage: stage(),
            featureAnalysis: stage(),
            privateAccountName: stage(),
            genderResolution: stage(),
        },
        gender: {
            male: 0,
            female: 0,
            unknown: 0,
            unknownRate: 0,
        },
        resolver: {
            ready: 0,
            applied: 0,
            inconclusive: 0,
            cutoff: 0,
            capacitySkipped: 0,
            admission: {
                eligible: 0,
                alreadyVerified: 0,
                officialOrGroup: 0,
                uncertainOrAbsent: 0,
                insufficientMedia: 0,
            },
            outcomes: {
                readyHighConfirmed: 0,
                evidenceInsufficient: 0,
                mixed: 0,
                unknown: 0,
                reconciliationApplied: 0,
                reconciliationInconclusive: 0,
                cutoff: 0,
                capacitySkipped: 0,
            },
        },
        gender_quality: {
            triage: {
                nonOk: 0,
                capacity: 0,
                outcome: {},
                source: {},
                genderConfidence: {},
                accountContext: {},
            },
            feature: {
                admission: {},
                finalDecision: {},
                accountContext: {},
                routeTerminal: {},
            },
            resolver: {
                earlyAdmission: 0,
                lateAdmission: 0,
                outcome: {},
            },
            finalClassificationSource: {},
            qualityGate: {
                observedUnknownRate: 0,
                worstCaseUnknownRate: 0,
                observedPass: true,
                worstCasePass: true,
            },
        },
    });
}

function tokenResponse(
    accessToken = 'adc-access-token-value-1234567890',
    expiresIn = 3_600,
) {
    return new Response(JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
    }), { status: 200 });
}

describe('replay job GCS JSON API client', () => {
    it('downloads one exact generation and create-only writes two fixed objects', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(tokenResponse())
            .mockResolvedValueOnce(new Response(ciphertext, {
                status: 200,
                headers: { 'x-goog-generation': baseConfig.bundleGeneration },
            }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const client = createReplayJobGcsClient(baseConfig, {
            fetch: fetchMock,
        });

        await expect(client.downloadBundle()).resolves.toEqual(ciphertext);
        await client.createClaim(
            '{"status":"claimed","schema":"analysis-v2-replay-job-claim-v1"}',
        );
        await client.createReport(validTerminalReport());

        expect(fetchMock).toHaveBeenCalledTimes(4);
        const download = new URL(fetchMock.mock.calls[1]![0].toString());
        expect(download.pathname).toContain('/download/storage/v1/b/');
        expect(download.searchParams.get('generation')).toBe('123456789');
        expect(download.searchParams.get('alt')).toBe('media');
        for (const index of [2, 3]) {
            const [url, init] = fetchMock.mock.calls[index]!;
            expect(init.method).toBe('POST');
            expect(init.headers.authorization).toBe(
                'Bearer adc-access-token-value-1234567890',
            );
            expect(new URL(url.toString()).searchParams.get(
                'ifGenerationMatch',
            )).toBe('0');
        }
        expect(Object.keys(client).sort()).toEqual([
            'createClaim',
            'createReport',
            'downloadBundle',
        ]);
    });

    it('fails closed on ciphertext size, hash, or generation mismatch', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(tokenResponse())
            .mockResolvedValueOnce(new Response(Buffer.from('wrong'), {
                status: 200,
                headers: { 'x-goog-generation': baseConfig.bundleGeneration },
            }));
        await expect(createReplayJobGcsClient(baseConfig, {
            fetch: fetchMock,
        }).downloadBundle()).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_JOB_BUNDLE_INTEGRITY_FAILED',
        );
    });

    it.each([412, 500])(
        'fails closed on claim create status %s without retry or list/delete',
        async status => {
            const fetchMock = vi.fn()
                .mockResolvedValueOnce(tokenResponse())
                .mockResolvedValueOnce(new Response(null, { status }));
            const client = createReplayJobGcsClient(baseConfig, {
                fetch: fetchMock,
            });
            await expect(client.createClaim(
                '{"status":"claimed","schema":"analysis-v2-replay-job-claim-v1"}',
            )).rejects.toThrow(
                status === 412
                    ? 'ANALYSIS_V2_REPLAY_JOB_CLAIM_COLLISION'
                    : 'ANALYSIS_V2_REPLAY_JOB_CLAIM_CREATE_AMBIGUOUS',
            );
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[1]![1].method).toBe('POST');
        },
    );

    it('rejects unsafe claim or report payloads before ADC fetch', async () => {
        const fetchMock = vi.fn();
        const client = createReplayJobGcsClient(baseConfig, {
            fetch: fetchMock,
        });
        await expect(client.createClaim('{"token":"raw-secret"}'))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
        await expect(client.createReport(
            '{"status":"ok","username":"private-person"}',
        )).rejects.toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['handle', 'terminal'])(
        'rejects handle-like aggregate key %s before ADC fetch',
        async key => {
            const fetchMock = vi.fn();
            const client = createReplayJobGcsClient(baseConfig, {
                fetch: fetchMock,
            });

            await expect(client.createReport(JSON.stringify({
                status: 'ok',
                aggregate: { [key]: 1 },
            }))).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT',
            );
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it.each([
        'private_handle',
        'victim.handle',
        'somehandle',
    ])(
        'rejects closed-report key variant %s before ADC fetch',
        async key => {
            const fetchMock = vi.fn();
            const client = createReplayJobGcsClient(baseConfig, {
                fetch: fetchMock,
            });
            const report = JSON.parse(validTerminalReport());
            report[key] = 1;

            await expect(client.createReport(JSON.stringify(report)))
                .rejects.toThrow(
                    'ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT',
                );
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it('refreshes ADC metadata tokens after their bounded lifetime', async () => {
        let now = 0;
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(tokenResponse(
                'first-adc-access-token-value-1234567890',
            ))
            .mockResolvedValueOnce(new Response(ciphertext, {
                status: 200,
                headers: { 'x-goog-generation': baseConfig.bundleGeneration },
            }))
            .mockResolvedValueOnce(tokenResponse(
                'second-adc-access-token-value-123456789',
            ))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const client = createReplayJobGcsClient(baseConfig, {
            fetch: fetchMock,
            now: () => now,
        });

        await client.downloadBundle();
        now += 3_700_000;
        await client.createClaim(
            '{"status":"claimed","schema":"analysis-v2-replay-job-claim-v1"}',
        );

        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(fetchMock.mock.calls[1]![1].headers.authorization).toBe(
            'Bearer first-adc-access-token-value-1234567890',
        );
        expect(fetchMock.mock.calls[3]![1].headers.authorization).toBe(
            'Bearer second-adc-access-token-value-123456789',
        );
    });

    it.each([
        ['claim', {
            claimObject: baseConfig.bundleObject,
        }],
        ['report', {
            reportObject: baseConfig.bundleObject,
        }],
        ['claim-report', {
            reportObject: baseConfig.claimObject,
        }],
    ])('requires bundle, claim, and report objects to be pairwise distinct (%s)', (
        _name,
        override,
    ) => {
        expect(() => createReplayJobGcsClient({
            ...baseConfig,
            ...override,
        })).toThrow('ANALYSIS_V2_REPLAY_JOB_GCS_CONFIGURATION_INVALID');
    });

    it('rejects an oversized encrypted envelope before ADC or bundle fetch', () => {
        const fetchMock = vi.fn();

        expect(() => createReplayJobGcsClient({
            ...baseConfig,
            bundleBytes: 400 * 1024 * 1024,
        }, {
            fetch: fetchMock,
        })).toThrow('ANALYSIS_V2_REPLAY_JOB_GCS_CONFIGURATION_INVALID');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never exposes a metadata token or raw metadata error', async () => {
        const rawToken = 'raw-adc-token-that-must-never-escape';
        const rawError = 'metadata backend leaked private details';
        const invalidTokenFetch = vi.fn().mockResolvedValueOnce(
            new Response(JSON.stringify({
                access_token: rawToken,
                token_type: 'Wrong',
                error: rawError,
            }), { status: 200 }),
        );

        const error = await createReplayJobGcsClient(baseConfig, {
            fetch: invalidTokenFetch,
        }).downloadBundle().catch(value => value);

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('ANALYSIS_V2_REPLAY_JOB_ADC_UNAVAILABLE');
        expect(error.message).not.toContain(rawToken);
        expect(error.message).not.toContain(rawError);
    });
});
