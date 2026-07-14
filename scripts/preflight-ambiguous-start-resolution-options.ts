export const AMBIGUOUS_START_CONFIRMATION =
    'I_VERIFIED_EXACT_APIFY_ACTOR_SLOT_AND_TIME_WINDOW_HAS_NO_RUN';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const CREDENTIAL_SLOTS = new Set([
    'primary',
    'secondary',
    'tertiary',
    'quaternary',
    'quinary',
]);

export interface AmbiguousStartListOptions {
    mode: 'list';
    limit: number;
}

export interface AmbiguousStartResolveOptions {
    mode: 'resolve';
    preflightId: string;
    operationKey: 'target-profile-fallback';
    inputHash: string;
    logicalProvider: 'apify';
    actorId: 'apify/instagram-profile-scraper';
    credentialSlot: string;
    maxChargeUsd: '0.002600000000';
    reservedAt: string;
    evidenceReferenceFile: string;
}

export type AmbiguousStartOptions =
    | AmbiguousStartListOptions
    | AmbiguousStartResolveOptions;

function fail(message: string): never {
    throw new Error(`invalid arguments: ${message}`);
}

function parseArguments(argv: string[]): Map<string, string | true> {
    const allowed = new Set([
        'list',
        'resolve',
        'limit',
        'preflight-id',
        'operation-key',
        'input-hash',
        'logical-provider',
        'actor-id',
        'credential-slot',
        'max-charge-usd',
        'reserved-at',
        'evidence-reference-file',
        'confirm',
    ]);
    const flags = new Set(['list', 'resolve']);
    const parsed = new Map<string, string | true>();

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) fail(`unexpected positional argument: ${token}`);
        const separator = token.indexOf('=');
        const name = token.slice(2, separator >= 0 ? separator : undefined);
        if (!allowed.has(name)) fail(`unknown option: --${name}`);
        if (parsed.has(name)) fail(`duplicate option: --${name}`);

        if (flags.has(name)) {
            if (separator >= 0) fail(`--${name} does not accept a value`);
            parsed.set(name, true);
            continue;
        }

        const value = separator >= 0 ? token.slice(separator + 1) : argv[index + 1];
        if (!value || (separator < 0 && value.startsWith('--'))) {
            fail(`--${name} requires a value`);
        }
        parsed.set(name, value);
        if (separator < 0) index += 1;
    }
    return parsed;
}

function required(parsed: Map<string, string | true>, name: string): string {
    const value = parsed.get(name);
    return typeof value === 'string' && value.length > 0
        ? value
        : fail(`--${name} is required`);
}

export function parseAmbiguousStartOptions(argv: string[]): AmbiguousStartOptions {
    const parsed = parseArguments(argv);
    const list = parsed.get('list') === true;
    const resolve = parsed.get('resolve') === true;
    if (list === resolve) fail('choose exactly one of --list or --resolve');

    if (list) {
        const forbidden = [...parsed.keys()].filter((name) =>
            name !== 'list' && name !== 'limit'
        );
        if (forbidden.length > 0) fail(`--list does not accept --${forbidden[0]}`);
        const rawLimit = typeof parsed.get('limit') === 'string'
            ? parsed.get('limit') as string
            : '20';
        if (!/^[1-9][0-9]*$/.test(rawLimit)) fail('--limit must be an integer from 1 through 100');
        const limit = Number(rawLimit);
        if (limit > 100) fail('--limit must be an integer from 1 through 100');
        return { mode: 'list', limit };
    }

    const expectedKeys = new Set([
        'resolve',
        'preflight-id',
        'operation-key',
        'input-hash',
        'logical-provider',
        'actor-id',
        'credential-slot',
        'max-charge-usd',
        'reserved-at',
        'evidence-reference-file',
        'confirm',
    ]);
    const unexpected = [...parsed.keys()].find((name) => !expectedKeys.has(name));
    if (unexpected) fail(`--resolve does not accept --${unexpected}`);

    const preflightId = required(parsed, 'preflight-id');
    const operationKey = required(parsed, 'operation-key');
    const inputHash = required(parsed, 'input-hash');
    const logicalProvider = required(parsed, 'logical-provider');
    const actorId = required(parsed, 'actor-id');
    const credentialSlot = required(parsed, 'credential-slot');
    const maxChargeUsd = required(parsed, 'max-charge-usd');
    const reservedAt = required(parsed, 'reserved-at');
    const evidenceReferenceFile = required(parsed, 'evidence-reference-file');
    const confirmation = required(parsed, 'confirm');

    if (!UUID_PATTERN.test(preflightId)) fail('--preflight-id must be a UUID');
    if (operationKey !== 'target-profile-fallback') fail('unsupported --operation-key');
    if (!SHA256_PATTERN.test(inputHash)) fail('--input-hash must be a lowercase SHA-256');
    if (logicalProvider !== 'apify') fail('unsupported --logical-provider');
    if (actorId !== 'apify/instagram-profile-scraper') fail('unsupported --actor-id');
    if (!CREDENTIAL_SLOTS.has(credentialSlot)) fail('unsupported --credential-slot');
    if (maxChargeUsd !== '0.002600000000') fail('--max-charge-usd must be 0.002600000000');
    if (!ISO_TIMESTAMP_PATTERN.test(reservedAt) || !Number.isFinite(Date.parse(reservedAt))) {
        fail('--reserved-at must be an ISO timestamp with timezone');
    }
    if (confirmation !== AMBIGUOUS_START_CONFIRMATION) {
        fail(`--confirm must equal ${AMBIGUOUS_START_CONFIRMATION}`);
    }

    return {
        mode: 'resolve',
        preflightId,
        operationKey,
        inputHash,
        logicalProvider,
        actorId,
        credentialSlot,
        maxChargeUsd,
        reservedAt,
        evidenceReferenceFile,
    };
}
