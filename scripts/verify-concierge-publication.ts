import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    buildConciergeManualPublication,
    buildConciergeManualPublicationDraft,
    ConciergePublicationError,
    type ConciergeCanonicalPublication,
    type ConciergeManualPublicationInput,
    type ConciergePublicationFailureDiagnostic,
} from '../lib/services/analysis/concierge-batch-publication';

const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,120}$/u;
const MAX_DIAGNOSTIC_VALUE_LENGTH = 160;
const REPLAY_IMAGE_PLACEHOLDER = 'https://example.invalid/concierge-replay-image';
const DIAGNOSTIC_REDACTIONS: readonly [RegExp, string][] = [
    [/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[REDACTED_DATABASE_URL]'],
    [/\bapify_api_[A-Za-z0-9]+/giu, '[REDACTED_APIFY_TOKEN]'],
    [/\beyJ[A-Za-z0-9._-]+/gu, '[REDACTED_JWT]'],
    [/(?:https?|wss?):\/\/[^\s"'<>?#]+\?[^\s"'<>]*/giu, '[REDACTED_URL]'],
];

/** JSON representation accepted for a persisted dry-run artifact. */
export interface ConciergePublicationDryRunArtifact {
    schema?: string;
    copyEvidence?: unknown;
    orders: readonly ConciergePublicationDryRunOrder[];
}

export interface ConciergePublicationDryRunOrder {
    orderId: string;
    input: ConciergeManualPublicationInput;
}

export interface ConciergePublicationDryRunSuccess {
    passed: true;
    orderId: string;
    resultHash: string;
    counts: ConciergeCanonicalPublication['counts'];
}

export interface ConciergePublicationDryRunFailure {
    passed: false;
    orderId: string;
    code: string;
    diagnostic: ConciergePublicationFailureDiagnostic;
    diagnostics: readonly ConciergePublicationFailureDiagnostic[];
}

export type ConciergePublicationDryRunResult =
    | ConciergePublicationDryRunSuccess
    | ConciergePublicationDryRunFailure;

export interface ConciergePublicationDryRunSummary {
    status: 'passed' | 'failed';
    checkedOrders: number;
    passedOrders: number;
    failedOrders: number;
    failuresByCode: Readonly<Record<string, number>>;
}

const IMAGE_URL_KEYS = new Set([
    'imageUrl', 'thumbnailUrl', 'profilePicUrl', 'profilePicUrlHD', 'profileImage',
]);
const URL_KEYS = new Set(['sourceUrl', 'canonicalUrl', 'url']);

/**
 * Converts the in-memory publication input to a JSON-safe replay artifact.
 * Maps are encoded as entry arrays so their key identity survives a round trip.
 * Image bytes and provider URLs are deliberately replaced with deterministic
 * placeholders; the publication contract only needs their presence and all
 * provider/AI work has already completed before this dump is written.
 */
export function serializeConciergePublicationValue(value: unknown): unknown {
    const visited = new WeakSet<object>();
    const serialize = (value: unknown, keyName?: string): unknown => {
        if (typeof value === 'string') {
            if (keyName === 'jpegBase64'
                || keyName === 'images'
                || keyName?.toLowerCase().includes('base64')
                || keyName?.toLowerCase().includes('token')) return 'AA==';
            if (IMAGE_URL_KEYS.has(keyName ?? '')) return value.length > 0 ? REPLAY_IMAGE_PLACEHOLDER : value;
            if (URL_KEYS.has(keyName ?? '')) return value.startsWith('/result/') ? value : 'https://example.invalid/concierge-replay-source';
            return value;
        }
        if (typeof value !== 'object' || value === null) return value;
        if (visited.has(value)) return '[circular]';
        visited.add(value);
        let result: unknown;
        if (value instanceof Map) {
            result = [...value.entries()].map(([entryKey, entryValue]) => [
                serialize(entryKey), serialize(entryValue),
            ]);
        } else if (Array.isArray(value)) {
            result = value.map(entry => serialize(entry, keyName));
        } else {
            const output: Record<string, unknown> = {};
            for (const [entryKey, entryValue] of Object.entries(value)) {
                output[entryKey] = serialize(entryValue, entryKey);
            }
            result = output;
        }
        visited.delete(value);
        return result;
    };
    return serialize(value);
}

export function serializeConciergePublicationInput(input: ConciergeManualPublicationInput): unknown {
    return serializeConciergePublicationValue(input);
}

/** Writes one order's immutable publication input for a later read-only check. */
export function writeConciergePublicationDryRunDump(
    input: ConciergeManualPublicationInput,
    configuredPath: string | undefined,
    additional?: { copyEvidence?: unknown },
): string | null {
    const rawPath = configuredPath?.trim();
    if (!rawPath) return null;
    const isDirectory = (() => {
        try {
            return statSync(rawPath).isDirectory();
        } catch {
            return !rawPath.toLowerCase().endsWith('.json');
        }
    })();
    const outputPath = isDirectory ? join(rawPath, `${input.orderId}.json`) : rawPath;
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    const artifact = {
        schema: 'concierge-publication-dry-run-v1',
        orderId: input.orderId,
        input: serializeConciergePublicationInput(input),
        ...(additional?.copyEvidence === undefined ? {} : {
            copyEvidence: serializeConciergePublicationValue(additional.copyEvidence),
        }),
    };
    writeFileSync(outputPath, `${JSON.stringify(artifact)}\n`, { encoding: 'utf8', mode: 0o600 });
    return outputPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUsername(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const username = value.trim().replace(/^@/u, '').toLowerCase();
    return USERNAME_PATTERN.test(username) ? username : null;
}

function mapEntries<T>(value: unknown, key: (value: unknown) => T): Map<T, unknown> {
    if (Array.isArray(value)) {
        const entries = value.map(item => {
            if (!Array.isArray(item) || item.length !== 2) {
                throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
            }
            return [key(item[0]), item[1]] as const;
        });
        return new Map(entries);
    }
    if (isRecord(value)) {
        return new Map(Object.entries(value).map(([entryKey, entryValue]) => [key(entryKey), entryValue] as const));
    }
    throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
}

function decodeInput(value: unknown): ConciergeManualPublicationInput {
    if (!isRecord(value) || !isRecord(value.replay)) {
        throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
    }
    const replay = value.replay;
    if (!isRecord(replay.bidirectionalInteractions)) {
        throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
    }
    const interactions = replay.bidirectionalInteractions;
    return {
        ...value,
        replay: {
            ...replay,
            profilesByOrdinal: mapEntries(replay.profilesByOrdinal, entry => {
                const ordinal = typeof entry === 'number' ? entry : Number(entry);
                if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
                    throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
                }
                return ordinal;
            }),
            classificationByOrdinal: mapEntries(replay.classificationByOrdinal, entry => {
                const ordinal = typeof entry === 'number' ? entry : Number(entry);
                if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
                    throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
                }
                return ordinal;
            }),
            bidirectionalInteractions: {
                ...interactions,
                candidatePostsByUsername: mapEntries(
                    interactions.candidatePostsByUsername,
                    entry => {
                        const username = normalizeUsername(entry);
                        if (!username) throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
                        return username;
                    },
                ),
                reverseLikeStatusByUsername: mapEntries(
                    interactions.reverseLikeStatusByUsername,
                    entry => {
                        const username = normalizeUsername(entry);
                        if (!username) throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
                        return username;
                    },
                ),
            },
        },
    } as unknown as ConciergeManualPublicationInput;
}

function safeDiagnostic(value: unknown): ConciergePublicationFailureDiagnostic {
    if (!isRecord(value)) return { check: 'unknown' };
    const rawCheck = typeof value.check === 'string' ? value.check : 'unknown';
    const check = rawCheck.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH);
    const ordinal = typeof value.ordinal === 'number' && Number.isSafeInteger(value.ordinal)
        ? value.ordinal
        : undefined;
    const username = normalizeUsername(value.username);
    const compared = isRecord(value.compared)
        ? Object.fromEntries(Object.entries(value.compared).flatMap(([key, comparedValue]) => {
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,64}$/u.test(key)) return [];
            if (comparedValue !== null
                && typeof comparedValue !== 'string'
                && typeof comparedValue !== 'number'
                && typeof comparedValue !== 'boolean') return [];
            const bounded = typeof comparedValue === 'string'
                ? DIAGNOSTIC_REDACTIONS.reduce(
                    (current, [pattern, replacement]) => current.replace(pattern, replacement),
                    comparedValue,
                ).slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH)
                : comparedValue;
            return [[key, bounded]];
        })) as Readonly<Record<string, string | number | boolean | null>>
        : undefined;
    return {
        check,
        ...(ordinal === undefined ? {} : { ordinal }),
        ...(username === null ? {} : { username }),
        ...(compared && Object.keys(compared).length > 0 ? { compared } : {}),
    };
}

function safeDiagnostics(value: unknown): readonly ConciergePublicationFailureDiagnostic[] {
    if (!Array.isArray(value)) return [safeDiagnostic(value)];
    const diagnostics = value.map(safeDiagnostic);
    return diagnostics.length > 0 ? diagnostics : [{ check: 'unknown' }];
}

function errorCode(error: unknown): string {
    if (error instanceof ConciergePublicationError && FAILURE_CODE_PATTERN.test(error.code)) {
        return error.code;
    }
    return 'CONCIERGE_PUBLICATION_DRY_RUN_FAILED';
}

/**
 * Runs the production draft builder and its complete publication validation
 * stack without invoking the publication store, copy generation, providers,
 * or Gemini.  This is intentionally the only validation entry point here.
 */
export function verifyConciergePublicationInput(
    input: ConciergeManualPublicationInput,
): Omit<ConciergePublicationDryRunSuccess, 'orderId'> | Omit<ConciergePublicationDryRunFailure, 'orderId'> {
    try {
        // A post-copy dump contains the complete input and must exercise the
        // same full builder the CAS publisher invokes; the first pre-draft
        // dump intentionally exercises only the score-bearing draft boundary.
        const publication = input.batchCandidateCopy !== undefined || input.batchHighRiskCopy !== undefined
            ? buildConciergeManualPublication(input)
            : buildConciergeManualPublicationDraft(input);
        return {
            passed: true,
            resultHash: publication.resultHash,
            counts: publication.counts,
        };
    } catch (error) {
        const diagnostic = error instanceof ConciergePublicationError
            ? safeDiagnostic(error.diagnostic)
            : { check: errorCode(error) };
        const diagnostics = error instanceof ConciergePublicationError
            ? safeDiagnostics(error.diagnostics)
            : [diagnostic];
        return {
            passed: false,
            code: errorCode(error),
            diagnostic,
            diagnostics,
        };
    }
}

function parseArtifact(value: unknown): ConciergePublicationDryRunOrder[] {
    const root = isRecord(value) ? value : null;
    const candidates = root && Array.isArray(root.orders)
        ? root.orders
        : [value];
    const orders = candidates.map(candidate => {
        if (!isRecord(candidate)) throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
        const inputValue = 'input' in candidate ? candidate.input : candidate;
        const input = decodeInput(inputValue);
        const orderId = typeof candidate.orderId === 'string'
            ? candidate.orderId
            : input.orderId;
        if (!ORDER_ID_PATTERN.test(orderId) || input.orderId !== orderId) {
            throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_INVALID');
        }
        return { orderId, input };
    });
    if (orders.length === 0) throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_EMPTY');
    const orderIds = new Set(orders.map(order => order.orderId));
    if (orderIds.size !== orders.length) throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_INPUT_DUPLICATE');
    return orders;
}

function readArtifactPath(inputPath: string): unknown {
    if (!statSync(inputPath).isDirectory()) {
        return JSON.parse(readFileSync(inputPath, 'utf8'));
    }
    const artifacts = readdirSync(inputPath)
        .filter(name => name.toLowerCase().endsWith('.json'))
        .sort()
        .map(name => JSON.parse(readFileSync(join(inputPath, name), 'utf8')));
    return { orders: artifacts };
}

function failureLine(result: ConciergePublicationDryRunFailure): string {
    const fields = [
        `code=${result.code}`,
        `check=${result.diagnostic.check}`,
        ...(result.diagnostic.ordinal === undefined ? [] : [`ordinal=${result.diagnostic.ordinal}`]),
        ...(result.diagnostic.username === undefined ? [] : [`username=${result.diagnostic.username}`]),
        ...(result.diagnostics.length > 1
            ? [`diagnostics=${JSON.stringify(result.diagnostics)}`]
            : result.diagnostic.compared === undefined
                ? []
                : [`compared=${JSON.stringify(result.diagnostic.compared)}`]),
    ];
    return `concierge publication dry-run failed: ${fields.join(' ')}`;
}

function summary(results: readonly ConciergePublicationDryRunResult[]): ConciergePublicationDryRunSummary {
    const failuresByCode: Record<string, number> = {};
    for (const result of results) {
        if (!result.passed) failuresByCode[result.code] = (failuresByCode[result.code] ?? 0) + 1;
    }
    return {
        status: results.some(result => !result.passed) ? 'failed' : 'passed',
        checkedOrders: results.length,
        passedOrders: results.filter(result => result.passed).length,
        failedOrders: results.filter(result => !result.passed).length,
        failuresByCode,
    };
}

function parseCli(args: readonly string[]): { inputPath: string; orderId?: string } {
    let inputPath = process.env.CONCIERGE_PUBLICATION_DRY_RUN_INPUT_PATH?.trim() ?? '';
    let orderId: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--input' || arg === '--order-id') {
            const value = args[index + 1];
            if (!value) throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_USAGE');
            if (arg === '--input') inputPath = value;
            else orderId = value;
            index += 1;
        } else if (arg.startsWith('--input=')) {
            inputPath = arg.slice('--input='.length);
        } else if (arg.startsWith('--order-id=')) {
            orderId = arg.slice('--order-id='.length);
        } else {
            throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_USAGE');
        }
    }
    if (!inputPath || (orderId !== undefined && !ORDER_ID_PATTERN.test(orderId))) {
        throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_USAGE');
    }
    return { inputPath, orderId };
}

export function runConciergePublicationDryRunCli(args: readonly string[]): number {
    const results: ConciergePublicationDryRunResult[] = [];
    try {
        const options = parseCli(args);
        const orders = parseArtifact(readArtifactPath(options.inputPath));
        const selected = options.orderId
            ? orders.filter(order => order.orderId === options.orderId)
            : orders;
        if (selected.length === 0) throw new Error('CONCIERGE_PUBLICATION_DRY_RUN_ORDER_NOT_FOUND');
        for (const order of selected) {
            const checked = verifyConciergePublicationInput(order.input);
            const result = checked.passed
                ? { ...checked, passed: true as const, orderId: order.orderId }
                : { ...checked, passed: false as const, orderId: order.orderId };
            results.push(result);
            if (result.passed) {
                process.stdout.write(`concierge publication dry-run passed: target=${normalizeUsername(order.input.targetUsername) ?? '<invalid>'}\n`);
            } else {
                process.stderr.write(`${failureLine(result)}\n`);
            }
        }
    } catch (error) {
        const code = error instanceof Error && FAILURE_CODE_PATTERN.test(error.message)
            ? error.message
            : 'CONCIERGE_PUBLICATION_DRY_RUN_FAILED';
        process.stderr.write(`concierge publication dry-run failed: code=${code} check=input\n`);
        process.stdout.write(`${JSON.stringify({
            status: 'failed', checkedOrders: 0, passedOrders: 0, failedOrders: 1,
            failuresByCode: { [code]: 1 },
        } satisfies ConciergePublicationDryRunSummary)}\n`);
        return 1;
    }
    const finalSummary = summary(results);
    process.stdout.write(`${JSON.stringify(finalSummary)}\n`);
    return finalSummary.failedOrders > 0 ? 1 : 0;
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    try {
        process.exitCode = runConciergePublicationDryRunCli(process.argv.slice(2));
    } catch {
        process.exitCode = 1;
    }
}
