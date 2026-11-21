import { z } from 'zod';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const CANDIDATE_LOCATOR_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const OBJECT_KEY_PATTERN = /^v1\/[0-9a-f]{32}\/(target|female|private)\/[0-9a-f]{32}\.webp$/;

export const RESULT_IMAGE_REGISTRY_RPC = Object.freeze({
    begin: 'begin_analysis_v2_result_image_manifest',
    register: 'register_analysis_v2_result_image_outcome',
    seal: 'seal_analysis_v2_result_image_manifest',
    loadPage: 'load_analysis_v2_result_image_manifest_page',
    claimPurge: 'claim_analysis_v2_result_image_purges',
    completePurge: 'complete_analysis_v2_result_image_purge',
});

export interface ResultImageRegistryClient {
    rpc(
        name: string,
        params: Record<string, unknown>
    ): PromiseLike<{
        data: unknown;
        error: { code?: string; message?: string } | null;
        status?: number;
    }>;
}

export type ResultImageRegistryClaim = {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
};

const kindSchema = z.enum(['target', 'female', 'private']);
const hashSchema = z.string().regex(HASH_PATTERN);
const objectKeySchema = z.string().regex(OBJECT_KEY_PATTERN);
const candidateLocatorSchema = z.string()
    .regex(CANDIDATE_LOCATOR_PATTERN)
    .refine(value => !/https?/i.test(value));
const timestampSchema = z.string().datetime({ offset: true });

const outcomeSchema = z.object({
    kind: kindSchema,
    candidateLocator: candidateLocatorSchema,
    sortOrdinal: z.number().int().min(0).max(50_000),
    sourceFingerprint: hashSchema.nullable(),
    status: z.enum(['ready', 'source_missing', 'capture_failed']),
    objectKey: objectKeySchema.nullable(),
    sha256: hashSchema.nullable(),
    byteSize: z.number().int().min(1).max(128 * 1024).nullable(),
    capturedAt: timestampSchema.nullable(),
    expiresAt: timestampSchema,
    failureCode: z.string().regex(FAILURE_CODE_PATTERN).nullable(),
    isMandatory: z.boolean(),
}).strict().superRefine((value, context) => {
    const targetIdentity = value.kind === 'target'
        && value.candidateLocator === 'target'
        && value.sortOrdinal === 0;
    const candidateIdentity = value.kind !== 'target'
        && value.candidateLocator !== 'target'
        && value.sortOrdinal >= 1;
    if (!targetIdentity && !candidateIdentity) {
        context.addIssue({
            code: 'custom',
            message: 'Invalid result image identity.',
        });
    }
    const shouldBeMandatory = value.sourceFingerprint !== null
        && (
            value.kind === 'target'
            || (value.kind === 'female' && value.sortOrdinal <= 3)
        );
    if (value.isMandatory !== shouldBeMandatory) {
        context.addIssue({
            code: 'custom',
            message: 'Invalid mandatory result image flag.',
        });
    }
    const metadataCount = [
        value.objectKey,
        value.sha256,
        value.byteSize,
        value.capturedAt,
    ].filter(item => item !== null).length;
    if (
        value.status === 'ready'
        && (
            value.sourceFingerprint === null
            || metadataCount !== 4
            || value.failureCode !== null
            || !value.objectKey?.includes(`/${value.kind}/`)
        )
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Invalid ready result image.',
        });
    }
    if (
        value.status === 'source_missing'
        && (
            value.sourceFingerprint !== null
            || metadataCount !== 0
            || value.failureCode !== null
        )
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Invalid source-missing result image.',
        });
    }
    if (
        value.status === 'capture_failed'
        && (
            value.sourceFingerprint === null
            || metadataCount !== 0
            || value.failureCode === null
        )
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Invalid failed result image.',
        });
    }
});

export type ResultImageRegistryOutcome = z.infer<typeof outcomeSchema>;

const beginResultSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    orderedManifestHash: hashSchema,
    expectedRows: z.number().int().min(0).max(50_001),
    sealed: z.boolean(),
}).strict();

const registerResultSchema = z.object({
    registered: z.boolean(),
    status: z.enum(['ready', 'source_missing', 'capture_failed']),
}).strict();

const sealResultSchema = z.object({
    orderedManifestHash: hashSchema,
    expectedRows: z.number().int().min(0).max(50_001),
    durableRows: z.number().int().min(0).max(50_001),
    sourcedImages: z.number().int().min(0).max(50_001),
    readyImages: z.number().int().min(0).max(50_001),
    captureFailedImages: z.number().int().min(0).max(50_001),
}).strict();

const purgeClaimSchema = z.object({
    objectKey: objectKeySchema,
    reason: z.enum(['owner_delete', 'expired']),
}).strict();

const sqlFailureSchema = z.enum([
    'ANALYSIS_V2_RESULT_IMAGE_CONFLICT',
    'ANALYSIS_V2_RESULT_IMAGE_FENCE_MISMATCH',
    'ANALYSIS_V2_RESULT_IMAGE_INVALID',
    'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY',
]);
const transientRpcCodes = new Set([
    '40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03', '58030',
    'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003',
    'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'EPIPE',
]);
const connectionFailureMessage = /\b(?:fetch failed|failed to fetch|network error|socket hang up|timed?\s*out|timeout|econnreset)\b/i;

export class ResultImageRegistryError extends Error {
    constructor(
        readonly code:
            | z.infer<typeof sqlFailureSchema>
            | 'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR'
            | 'RESULT_IMAGE_REGISTRY_INVALID_INPUT'
            | 'RESULT_IMAGE_REGISTRY_INVALID_RESPONSE'
            | 'RESULT_IMAGE_REGISTRY_OPERATION_FAILED'
    ) {
        super(code);
        this.name = 'ResultImageRegistryError';
    }
}

function registryRpcError(error: unknown, status?: number): ResultImageRegistryError {
    const { code, message, name } = (error ?? {}) as {
        code?: unknown;
        message?: unknown;
        name?: unknown;
    };
    if (code === 'P0001' || !code) {
        const parsed = sqlFailureSchema.safeParse(message);
        if (parsed.success) return new ResultImageRegistryError(parsed.data);
    }
    if (typeof code === 'string' && code) {
        const transient = transientRpcCodes.has(code) || /^(?:08|53)[A-Z0-9]{3}$/.test(code);
        return new ResultImageRegistryError(transient
            ? 'ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR'
            : 'RESULT_IMAGE_REGISTRY_OPERATION_FAILED');
    }
    // The SQL transaction can commit before its HTTP response is truncated.
    // postgrest-js reports that decoding failure with status zero. On retry
    // the finalizer reads the committed manifest before capturing any bytes.
    const transient = status === undefined
        ? name === 'AbortError' || name === 'TimeoutError' || name === 'SyntaxError'
            || (typeof message === 'string' && connectionFailureMessage.test(message))
        : status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);
    if (transient) {
        return new ResultImageRegistryError('ANALYSIS_V2_RESULT_IMAGE_PERSISTENCE_ERROR');
    }
    return new ResultImageRegistryError('RESULT_IMAGE_REGISTRY_OPERATION_FAILED');
}

function parseClaim(input: ResultImageRegistryClaim): ResultImageRegistryClaim {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !UUID_PATTERN.test(input.claimToken)
        || !HASH_PATTERN.test(input.jobInputHash)
    ) {
        throw new ResultImageRegistryError(
            'RESULT_IMAGE_REGISTRY_INVALID_INPUT'
        );
    }
    return {
        requestId: input.requestId.toLowerCase(),
        jobKey: input.jobKey,
        claimToken: input.claimToken.toLowerCase(),
        jobInputHash: input.jobInputHash,
    };
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        throw new ResultImageRegistryError(
            'RESULT_IMAGE_REGISTRY_INVALID_INPUT'
        );
    }
    return parsed.data;
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        throw new ResultImageRegistryError(
            'RESULT_IMAGE_REGISTRY_INVALID_RESPONSE'
        );
    }
    return parsed.data;
}

function validateWorkClaim(input: {
    claimToken: string;
    limit: number;
    leaseSeconds: number;
}) {
    if (
        !UUID_PATTERN.test(input.claimToken)
        || !Number.isSafeInteger(input.limit)
        || input.limit < 1
        || input.limit > 100
        || !Number.isSafeInteger(input.leaseSeconds)
        || input.leaseSeconds < 30
        || input.leaseSeconds > 900
    ) {
        throw new ResultImageRegistryError(
            'RESULT_IMAGE_REGISTRY_INVALID_INPUT'
        );
    }
}

export function createResultImageRegistry(
    client: ResultImageRegistryClient
) {
    async function rpc(
        name: string,
        params: Record<string, unknown>
    ): Promise<unknown> {
        let response;
        try {
            response = await client.rpc(name, params);
        } catch (error) {
            throw registryRpcError(error);
        }
        if (response?.error) throw registryRpcError(response.error, response.status);
        return response?.data;
    }

    function claimParams(input: ResultImageRegistryClaim) {
        const claim = parseClaim(input);
        return {
            p_request_id: claim.requestId,
            p_job_key: claim.jobKey,
            p_claim_token: claim.claimToken,
            p_job_input_hash: claim.jobInputHash,
        };
    }

    return {
        async beginManifest(input: ResultImageRegistryClaim & {
            orderedManifestHash: string;
            expectedRows: number;
        }) {
            const hash = parseInput(hashSchema, input.orderedManifestHash);
            if (
                !Number.isSafeInteger(input.expectedRows)
                || input.expectedRows < 0
                || input.expectedRows > 50_001
            ) {
                throw new ResultImageRegistryError(
                    'RESULT_IMAGE_REGISTRY_INVALID_INPUT'
                );
            }
            const data = await rpc(RESULT_IMAGE_REGISTRY_RPC.begin, {
                ...claimParams(input),
                p_ordered_manifest_hash: hash,
                p_expected_rows: input.expectedRows,
            });
            return parseResponse(beginResultSchema, data);
        },

        async registerOutcome(input: ResultImageRegistryClaim & {
            outcome: ResultImageRegistryOutcome;
        }) {
            const outcome = parseInput(outcomeSchema, input.outcome);
            const data = await rpc(RESULT_IMAGE_REGISTRY_RPC.register, {
                ...claimParams(input),
                p_outcome: outcome,
            });
            return parseResponse(registerResultSchema, data);
        },

        async sealManifest(input: ResultImageRegistryClaim & {
            orderedManifestHash: string;
        }) {
            const data = await rpc(RESULT_IMAGE_REGISTRY_RPC.seal, {
                ...claimParams(input),
                p_ordered_manifest_hash: parseInput(
                    hashSchema,
                    input.orderedManifestHash
                ),
            });
            return parseResponse(sealResultSchema, data);
        },

        async loadManifestPage(input: ResultImageRegistryClaim & {
            afterOrdinal: number;
            pageSize: number;
        }): Promise<ResultImageRegistryOutcome[]> {
            if (
                !Number.isSafeInteger(input.afterOrdinal)
                || input.afterOrdinal < -1
                || input.afterOrdinal > 50_000
                || !Number.isSafeInteger(input.pageSize)
                || input.pageSize < 1
                || input.pageSize > 500
            ) {
                throw new ResultImageRegistryError(
                    'RESULT_IMAGE_REGISTRY_INVALID_INPUT'
                );
            }
            const data = await rpc(RESULT_IMAGE_REGISTRY_RPC.loadPage, {
                ...claimParams(input),
                p_after_ordinal: input.afterOrdinal,
                p_page_size: input.pageSize,
            });
            return parseResponse(z.array(outcomeSchema).max(500), data);
        },

        async claimPurge(input: {
            claimToken: string;
            limit: number;
            leaseSeconds: number;
        }) {
            validateWorkClaim(input);
            const data = await rpc(RESULT_IMAGE_REGISTRY_RPC.claimPurge, {
                p_claim_token: input.claimToken.toLowerCase(),
                p_limit: input.limit,
                p_lease_seconds: input.leaseSeconds,
            });
            return parseResponse(z.array(purgeClaimSchema).max(100), data);
        },

        async completePurge(input: {
            objectKey: string;
            claimToken: string;
            deleted: boolean;
        }) {
            const parsed = parseInput(z.object({
                objectKey: objectKeySchema,
                claimToken: z.string().regex(UUID_PATTERN),
                deleted: z.boolean(),
            }).strict(), input);
            const data = await rpc(RESULT_IMAGE_REGISTRY_RPC.completePurge, {
                p_object_key: parsed.objectKey,
                p_claim_token: parsed.claimToken.toLowerCase(),
                p_deleted: parsed.deleted,
            });
            return parseResponse(z.boolean(), data);
        },
    };
}

export type ResultImageRegistry = ReturnType<
    typeof createResultImageRegistry
>;
