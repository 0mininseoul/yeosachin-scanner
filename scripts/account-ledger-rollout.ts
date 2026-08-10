import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

export const ACCOUNT_LEDGER_COMMAND_VERSION = 'account-ledger-v1';
export const ACCOUNT_LEDGER_EXPECTED_LEGACY_E2E_COUNT = 17;
export const ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION = '--confirm-account-ledger-activation';

const LEGACY_CANDIDATE_HMAC_DOMAIN = 'account-ledger-legacy-e2e-candidates-v1';
const AUDIT_SECRET_ACCOUNT = 'audit-secret-v1';
const EXPECTED_HMAC_ACCOUNT = 'expected-legacy-e2e-hmac-v1';
const OPERATOR_ACCOUNT_ID_ACCOUNT = 'operator-account-id-v1';
const INTERNAL_TESTER_ACCOUNT_IDS_ACCOUNT = 'internal-tester-account-ids-v1';
const E2E_RUNNER_PLANS = ['basic', 'standard'] as const;
const RUNNER_METADATA_KEY = 'analysis_test_runner_v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type AccountLedgerRolloutMode = 'audit' | 'plan' | 'apply' | 'provision';
export type E2eRunnerPlan = typeof E2E_RUNNER_PLANS[number];

export interface AccountLedgerRolloutArgs {
    mode: AccountLedgerRolloutMode;
    confirmed?: boolean;
}

export interface AccountLedgerKeychain {
    read(account: string): Promise<string | null>;
    write(account: string, value: string): Promise<void>;
}

export interface AccountLedgerClassificationPlan {
    assignments: readonly Record<string, unknown>[];
    totalCount: number;
    legacyE2eCount: number;
    operatorCount: number;
    internalTesterCount: number;
    productionExternalCount: number;
}

export interface AccountLedgerClient {
    getRolloutState(): Promise<{ state: 'pending' | 'active'; commandVersion: string | null }>;
    listLegacyE2eCandidateIds(): Promise<readonly string[]>;
    buildClassificationPlan(input: {
        legacyCandidateIds: readonly string[];
        operatorAccountIds: readonly string[];
        internalTesterAccountIds: readonly string[];
    }): Promise<AccountLedgerClassificationPlan>;
    applyClassificationPlan(input: {
        assignments: readonly Record<string, unknown>[];
        commandVersion: string;
        activatePaidEver: boolean;
    }): Promise<{ updatedCount: number; evidenceCount: number; paidAccountCount: number }>;
    provisionRunner(input: {
        userId: string;
        email: string;
        runnerPlan: E2eRunnerPlan;
        commandVersion: string;
    }): Promise<{ runnerPlan: E2eRunnerPlan; created: boolean }>;
    listRunnerPlans(): Promise<readonly string[]>;
}

export interface AccountLedgerAuthAdmin {
    createUser(input: {
        email: string;
        password: string;
        runnerPlan: E2eRunnerPlan;
        appMetadata: Record<string, string>;
    }): Promise<{ id: string; appMetadata: Record<string, unknown> }>;
    getUser(userId: string): Promise<{ id: string; appMetadata: Record<string, unknown> } | null>;
    findUserByEmail(email: string): Promise<{ id: string; appMetadata: Record<string, unknown> } | null>;
}

export interface AccountLedgerRolloutDependencies {
    keychain: AccountLedgerKeychain;
    ledger: AccountLedgerClient;
    auth: AccountLedgerAuthAdmin;
    report(value: Readonly<Record<string, string | number | boolean>>): void;
    randomBytes?(size: number): Buffer;
}

interface VerifiedLegacyCandidates {
    candidateIds: readonly string[];
}

interface ClassificationInputs extends VerifiedLegacyCandidates {
    operatorAccountIds: readonly string[];
    internalTesterAccountIds: readonly string[];
}

interface RunnerCredential {
    email: string;
    password: string;
    userId?: string;
}

function fail(code: string): never {
    throw new Error(code);
}

function normalizedUuid(value: unknown): string {
    if (typeof value !== 'string') fail('ACCOUNT_LEDGER_IDENTIFIER_INVALID');
    const normalized = value.trim().toLowerCase();
    if (normalized !== value || !UUID_PATTERN.test(normalized)) {
        fail('ACCOUNT_LEDGER_IDENTIFIER_INVALID');
    }
    return normalized;
}

function normalizedUniqueIds(values: readonly string[], max: number): string[] {
    if (!Array.isArray(values) || values.length === 0 || values.length > max) {
        fail('ACCOUNT_LEDGER_IDENTIFIER_SET_INVALID');
    }
    const normalized = values.map(normalizedUuid).sort();
    if (new Set(normalized).size !== normalized.length) {
        fail('ACCOUNT_LEDGER_IDENTIFIER_SET_INVALID');
    }
    return normalized;
}

function parseStoredIdentifierList(value: string | null, max: number): string[] {
    if (!value) fail('ACCOUNT_LEDGER_KEYCHAIN_ITEM_MISSING');
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        fail('ACCOUNT_LEDGER_KEYCHAIN_ITEM_INVALID');
    }
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
        fail('ACCOUNT_LEDGER_KEYCHAIN_ITEM_INVALID');
    }
    return normalizedUniqueIds(parsed, max);
}

function requireKeychainSecret(value: string | null): string {
    if (!value || !BASE64URL_32_BYTES_PATTERN.test(value)) {
        fail('ACCOUNT_LEDGER_KEYCHAIN_SECRET_INVALID');
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== value) {
        fail('ACCOUNT_LEDGER_KEYCHAIN_SECRET_INVALID');
    }
    return value;
}

function constantTimeHmacEqual(actual: string, expected: string): boolean {
    if (!BASE64URL_32_BYTES_PATTERN.test(actual) || !BASE64URL_32_BYTES_PATTERN.test(expected)) {
        return false;
    }
    const actualBytes = Buffer.from(actual, 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    return actualBytes.length === expectedBytes.length
        && timingSafeEqual(actualBytes, expectedBytes);
}

export function createLegacyCandidateHmac(
    candidateIds: readonly string[],
    auditSecret: string,
): string {
    const normalized = normalizedUniqueIds(candidateIds, 100);
    return createHmac('sha256', auditSecret)
        .update(`${LEGACY_CANDIDATE_HMAC_DOMAIN}\n${normalized.join('\n')}`, 'utf8')
        .digest('base64url');
}

function report(
    dependencies: AccountLedgerRolloutDependencies,
    value: Readonly<Record<string, string | number | boolean>>,
): void {
    dependencies.report(Object.freeze({ ...value }));
}

async function verifyLegacyCandidates(
    dependencies: AccountLedgerRolloutDependencies,
): Promise<VerifiedLegacyCandidates> {
    const candidateIds = normalizedUniqueIds(
        await dependencies.ledger.listLegacyE2eCandidateIds(),
        100,
    );
    if (candidateIds.length !== ACCOUNT_LEDGER_EXPECTED_LEGACY_E2E_COUNT) {
        fail('ACCOUNT_LEDGER_LEGACY_CANDIDATE_COUNT_MISMATCH');
    }

    const [auditSecretValue, expectedHmacValue] = await Promise.all([
        dependencies.keychain.read(AUDIT_SECRET_ACCOUNT),
        dependencies.keychain.read(EXPECTED_HMAC_ACCOUNT),
    ]);
    const auditSecret = requireKeychainSecret(auditSecretValue);
    const expectedHmac = requireKeychainSecret(expectedHmacValue);
    const actualHmac = createLegacyCandidateHmac(candidateIds, auditSecret);
    if (!constantTimeHmacEqual(actualHmac, expectedHmac)) {
        fail('ACCOUNT_LEDGER_LEGACY_CANDIDATE_HMAC_MISMATCH');
    }
    return { candidateIds };
}

async function loadClassificationInputs(
    dependencies: AccountLedgerRolloutDependencies,
): Promise<ClassificationInputs> {
    const legacy = await verifyLegacyCandidates(dependencies);
    const [operatorValue, internalTesterValue] = await Promise.all([
        dependencies.keychain.read(OPERATOR_ACCOUNT_ID_ACCOUNT),
        dependencies.keychain.read(INTERNAL_TESTER_ACCOUNT_IDS_ACCOUNT),
    ]);
    const operatorAccountIds = normalizedUniqueIds(
        [normalizedUuid(operatorValue)],
        1,
    );
    const internalTesterAccountIds = parseStoredIdentifierList(internalTesterValue, 16);
    const allIds = [
        ...legacy.candidateIds,
        ...operatorAccountIds,
        ...internalTesterAccountIds,
    ];
    if (new Set(allIds).size !== allIds.length) {
        fail('ACCOUNT_LEDGER_CLASSIFICATION_IDENTIFIER_OVERLAP');
    }
    return { ...legacy, operatorAccountIds, internalTesterAccountIds };
}

async function buildVerifiedClassificationPlan(
    dependencies: AccountLedgerRolloutDependencies,
): Promise<AccountLedgerClassificationPlan> {
    const inputs = await loadClassificationInputs(dependencies);
    const plan = await dependencies.ledger.buildClassificationPlan({
        legacyCandidateIds: inputs.candidateIds,
        operatorAccountIds: inputs.operatorAccountIds,
        internalTesterAccountIds: inputs.internalTesterAccountIds,
    });
    if (
        !Number.isInteger(plan.totalCount)
        || plan.totalCount < 1
        || plan.totalCount > 100
        || plan.assignments.length !== plan.totalCount
        || plan.legacyE2eCount !== ACCOUNT_LEDGER_EXPECTED_LEGACY_E2E_COUNT
        || plan.operatorCount !== inputs.operatorAccountIds.length
        || plan.internalTesterCount !== inputs.internalTesterAccountIds.length
        || plan.productionExternalCount < 0
        || plan.legacyE2eCount + plan.operatorCount + plan.internalTesterCount
            + plan.productionExternalCount !== plan.totalCount
    ) {
        fail('ACCOUNT_LEDGER_CLASSIFICATION_PLAN_INVALID');
    }
    return plan;
}

function assertMutationConfirmation(args: AccountLedgerRolloutArgs): void {
    if ((args.mode === 'apply' || args.mode === 'provision') && args.confirmed !== true) {
        fail(`${ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION}_REQUIRED`);
    }
}

function assertActiveCommand(
    state: { state: 'pending' | 'active'; commandVersion: string | null },
): void {
    if (state.state !== 'active' || state.commandVersion !== ACCOUNT_LEDGER_COMMAND_VERSION) {
        fail('ACCOUNT_LEDGER_ROLLOUT_NOT_ACTIVE');
    }
}

function parseRunnerCredential(value: string | null): RunnerCredential | null {
    if (value === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        fail('ACCOUNT_LEDGER_E2E_RUNNER_CREDENTIAL_INVALID');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('ACCOUNT_LEDGER_E2E_RUNNER_CREDENTIAL_INVALID');
    }
    const candidate = parsed as Record<string, unknown>;
    if (
        typeof candidate.email !== 'string'
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.email)
        || typeof candidate.password !== 'string'
        || candidate.password.length < 16
        || (candidate.userId !== undefined && typeof candidate.userId !== 'string')
    ) {
        fail('ACCOUNT_LEDGER_E2E_RUNNER_CREDENTIAL_INVALID');
    }
    return {
        email: candidate.email,
        password: candidate.password,
        ...(candidate.userId === undefined ? {} : { userId: normalizedUuid(candidate.userId) }),
    };
}

function serializeRunnerCredential(credential: RunnerCredential): string {
    return JSON.stringify(credential);
}

function generatedRunnerCredential(
    randomBytes: (size: number) => Buffer,
): RunnerCredential {
    const random = randomBytes(24).toString('base64url');
    return {
        email: `runner-${randomBytes(16).toString('hex')}@e2e.invalid`,
        password: `E2e.${random}.ledger`,
    };
}

function assertRunnerMetadata(
    user: { id: string; appMetadata: Record<string, unknown> },
    runnerPlan: E2eRunnerPlan,
): string {
    const userId = normalizedUuid(user.id);
    if (user.appMetadata[RUNNER_METADATA_KEY] !== runnerPlan) {
        fail('ACCOUNT_LEDGER_E2E_RUNNER_METADATA_MISMATCH');
    }
    return userId;
}

async function resolveRunnerUser(
    runnerPlan: E2eRunnerPlan,
    dependencies: AccountLedgerRolloutDependencies,
): Promise<{ credential: RunnerCredential; userId: string }> {
    const credentialAccount = `e2e-runner-${runnerPlan}-v1`;
    const random = dependencies.randomBytes ?? nodeRandomBytes;
    let credential = parseRunnerCredential(await dependencies.keychain.read(credentialAccount));
    if (credential === null) {
        credential = generatedRunnerCredential(random);
        await dependencies.keychain.write(credentialAccount, serializeRunnerCredential(credential));
    }

    if (credential.userId) {
        const existing = await dependencies.auth.getUser(credential.userId);
        if (!existing) fail('ACCOUNT_LEDGER_E2E_RUNNER_AUTH_MISSING');
        return { credential, userId: assertRunnerMetadata(existing, runnerPlan) };
    }

    let user: { id: string; appMetadata: Record<string, unknown> };
    try {
        user = await dependencies.auth.createUser({
            email: credential.email,
            password: credential.password,
            runnerPlan,
            appMetadata: { [RUNNER_METADATA_KEY]: runnerPlan },
        });
    } catch {
        const existing = await dependencies.auth.findUserByEmail(credential.email);
        if (!existing) fail('ACCOUNT_LEDGER_E2E_RUNNER_AUTH_CREATE_FAILED');
        user = existing;
    }
    const userId = assertRunnerMetadata(user, runnerPlan);
    credential = { ...credential, userId };
    await dependencies.keychain.write(credentialAccount, serializeRunnerCredential(credential));
    return { credential, userId };
}

function assertExactRunnerPlans(plans: readonly string[]): void {
    const normalized = [...plans].sort();
    if (
        normalized.length !== E2E_RUNNER_PLANS.length
        || normalized[0] !== E2E_RUNNER_PLANS[0]
        || normalized[1] !== E2E_RUNNER_PLANS[1]
    ) {
        fail('ACCOUNT_LEDGER_E2E_RUNNER_REGISTRY_MISMATCH');
    }
}

export async function runAccountLedgerRollout(
    args: AccountLedgerRolloutArgs,
    dependencies: AccountLedgerRolloutDependencies,
): Promise<void> {
    assertMutationConfirmation(args);
    const state = await dependencies.ledger.getRolloutState();

    if (args.mode === 'provision') {
        assertActiveCommand(state);
        let createdCount = 0;
        for (const runnerPlan of E2E_RUNNER_PLANS) {
            const { credential, userId } = await resolveRunnerUser(runnerPlan, dependencies);
            const result = await dependencies.ledger.provisionRunner({
                userId,
                email: credential.email,
                runnerPlan,
                commandVersion: ACCOUNT_LEDGER_COMMAND_VERSION,
            });
            if (result.runnerPlan !== runnerPlan) {
                fail('ACCOUNT_LEDGER_E2E_RUNNER_PROVISION_RESULT_INVALID');
            }
            if (result.created) createdCount += 1;
        }
        assertExactRunnerPlans(await dependencies.ledger.listRunnerPlans());
        report(dependencies, {
            mode: 'provision',
            status: 'provisioned',
            runnerCount: E2E_RUNNER_PLANS.length,
            createdCount,
        });
        return;
    }

    if (state.state === 'active') {
        if (state.commandVersion !== ACCOUNT_LEDGER_COMMAND_VERSION) {
            fail('ACCOUNT_LEDGER_ROLLOUT_COMMAND_VERSION_CONFLICT');
        }
        report(dependencies, {
            mode: args.mode,
            status: args.mode === 'apply' ? 'already_active' : 'active',
        });
        return;
    }

    if (args.mode === 'audit') {
        const verified = await verifyLegacyCandidates(dependencies);
        report(dependencies, {
            mode: 'audit',
            status: 'verified',
            legacyCandidateCount: verified.candidateIds.length,
            expectedLegacyCandidateCount: ACCOUNT_LEDGER_EXPECTED_LEGACY_E2E_COUNT,
        });
        return;
    }

    const plan = await buildVerifiedClassificationPlan(dependencies);
    if (args.mode === 'plan') {
        report(dependencies, {
            mode: 'plan',
            status: 'ready',
            totalCount: plan.totalCount,
            legacyE2eCount: plan.legacyE2eCount,
            operatorCount: plan.operatorCount,
            internalTesterCount: plan.internalTesterCount,
            productionExternalCount: plan.productionExternalCount,
        });
        return;
    }

    const applied = await dependencies.ledger.applyClassificationPlan({
        assignments: plan.assignments,
        commandVersion: ACCOUNT_LEDGER_COMMAND_VERSION,
        activatePaidEver: true,
    });
    if (
        !Number.isInteger(applied.updatedCount)
        || applied.updatedCount < 0
        || !Number.isInteger(applied.evidenceCount)
        || applied.evidenceCount < 0
        || !Number.isInteger(applied.paidAccountCount)
        || applied.paidAccountCount < 0
    ) {
        fail('ACCOUNT_LEDGER_CLASSIFICATION_APPLY_RESULT_INVALID');
    }
    report(dependencies, {
        mode: 'apply',
        status: 'activated',
        updatedCount: applied.updatedCount,
        evidenceCount: applied.evidenceCount,
        paidAccountCount: applied.paidAccountCount,
    });
}

export function parseAccountLedgerRolloutArgs(
    args: readonly string[],
): AccountLedgerRolloutArgs {
    let mode: AccountLedgerRolloutMode = 'audit';
    let modeSeen = false;
    let confirmationCount = 0;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION) {
            confirmationCount += 1;
            continue;
        }
        if (argument === '--mode') {
            if (modeSeen) fail('ACCOUNT_LEDGER_ROLLOUT_ARGUMENT_INVALID');
            const value = args[index + 1];
            if (value !== 'audit' && value !== 'plan' && value !== 'apply' && value !== 'provision') {
                fail('ACCOUNT_LEDGER_ROLLOUT_ARGUMENT_INVALID');
            }
            mode = value;
            modeSeen = true;
            index += 1;
            continue;
        }
        fail('ACCOUNT_LEDGER_ROLLOUT_ARGUMENT_INVALID');
    }
    if (confirmationCount > 1) fail(`${ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION}_REQUIRED`);
    if ((mode === 'apply' || mode === 'provision') && confirmationCount !== 1) {
        fail(`${ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION}_REQUIRED`);
    }
    if ((mode === 'audit' || mode === 'plan') && confirmationCount !== 0) {
        fail('ACCOUNT_LEDGER_ROLLOUT_ARGUMENT_INVALID');
    }
    return confirmationCount === 1 ? { mode, confirmed: true } : { mode };
}
