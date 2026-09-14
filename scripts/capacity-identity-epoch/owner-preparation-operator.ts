import {
    canonicalDigest,
    epochFail,
    hasExactKeys,
    isObject,
    isRole,
    ROLES,
    SLOTS,
    type Role,
} from './contracts';
import {
    assertPreparationAction,
    canonicalPreparationProjection,
    selectDesiredIdentityGraph,
    summarizePreparation,
    type IdentityAccountObservation,
    type IdentityGraphObservation,
    type IdentitySelection,
    type PreparationAction,
} from './owner-preparation';

const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_ATOM = /^[^\u0000-\u001f\u007f]{1,2048}$/;

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'EVIDENCE_UNAVAILABLE' | 'PROPOSAL_STALE' | 'QUIESCENCE_PENDING' | 'IDENTITY_CONFLICT' | 'OBSERVATION_RACE'): never {
    epochFail(code);
}

export type PreparationCommand = Readonly<{
    command: 'prepare.inspect' | 'prepare.apply' | 'epoch.inspect' | 'epoch.apply';
    approvedDigest?: string;
    through?: 'VERIFIED';
}>;

export function parsePreparationCommand(argv: readonly string[]): PreparationCommand {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) fail('ADAPTER_REQUEST_INVALID');
    if (argv.length < 2 || (argv[0] !== 'prepare' && argv[0] !== 'epoch')) fail('ADAPTER_REQUEST_INVALID');
    const phase = argv[0];
    const action = argv[1];
    if (action !== 'inspect' && action !== 'apply') fail('ADAPTER_REQUEST_INVALID');
    const command = `${phase}.${action}` as PreparationCommand['command'];
    let approvedDigest: string | undefined;
    let through: 'VERIFIED' | undefined;
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--approved-digest') {
            if (approvedDigest !== undefined || index + 1 >= argv.length) fail('ADAPTER_REQUEST_INVALID');
            const value = argv[++index]!;
            if (!DIGEST.test(value)) fail('ADAPTER_REQUEST_INVALID');
            approvedDigest = value;
            continue;
        }
        if (arg === '--through') {
            if (through !== undefined || index + 1 >= argv.length || argv[++index] !== 'VERIFIED') fail('ADAPTER_REQUEST_INVALID');
            through = 'VERIFIED';
            continue;
        }
        fail('ADAPTER_REQUEST_INVALID');
    }
    const isApply = action === 'apply';
    const isEpoch = phase === 'epoch';
    if (isApply !== (approvedDigest !== undefined)
        || (isEpoch && isApply) !== (through !== undefined)
        || (!isEpoch && through !== undefined)) fail('ADAPTER_REQUEST_INVALID');
    return Object.freeze({ command, ...(approvedDigest === undefined ? {} : { approvedDigest }), ...(through === undefined ? {} : { through }) });
}

export type PreparationQueueObservation = Readonly<{
    resource: string;
    state: 'PAUSED' | 'RUNNING';
    empty: boolean;
    complete: boolean;
}>;

export type PreparationSchedulerObservation = Readonly<{
    resource: string;
    state: 'PAUSED' | 'ENABLED';
    pauseEpochMs: number;
    lastAttemptMs: number | null;
}>;

export type PreparationObservation = Readonly<{
    identityGraph: IdentityGraphObservation;
    readiness: Readonly<{
        ready: boolean;
        analysisV2AdmissionEnabled: boolean;
        earlybirdWebhookAutoAdmissionEnabled: boolean;
    }>;
    queues: Readonly<Record<Role, PreparationQueueObservation>>;
    schedulers: Readonly<Record<Role, PreparationSchedulerObservation>>;
    retention: Readonly<{ resource: string; enabled: boolean }>;
}>;

export type PreparationAccountCreateInput = Readonly<{ slot: (typeof SLOTS)[number]; identity: Readonly<{ identity: string; project: string }> }>;

export type PreparationMutator = Readonly<{
    createAccount(input: PreparationAccountCreateInput): Promise<void>;
    readAccount(input: Readonly<{ identity: Readonly<{ identity: string; project: string }> }>): Promise<IdentityAccountObservation>;
    pauseScheduler(input: Readonly<{ role: Role; resource: string }>): Promise<void>;
    readScheduler(input: Readonly<{ role: Role; resource: string }>): Promise<PreparationSchedulerObservation>;
}>;

export type PreparationOperatorOptions = Readonly<{
    discover: () => Promise<PreparationObservation>;
    mutate: PreparationMutator;
    now?: () => number;
    quiescence: Readonly<{ timeoutMs: number; graceMs: number }>;
}>;

export type PreparationProposal = Readonly<{
    observation: PreparationObservation;
    selection: IdentitySelection;
    discoveryDigest: string;
    summary: Readonly<ReturnType<typeof summarizePreparation> & { discoveryDigest: string }>;
}>;

function assertRoleRecord<T>(value: unknown, validate: (item: unknown) => boolean): asserts value is Record<Role, T> {
    if (!isObject(value) || !hasExactKeys(value, ROLES) || !ROLES.every(role => validate(value[role]))) fail('EVIDENCE_UNAVAILABLE');
}

function assertObservation(value: unknown): asserts value is PreparationObservation {
    if (!isObject(value) || !isObject(value.identityGraph) || !isObject(value.readiness)
        || !isObject(value.queues) || !isObject(value.schedulers) || !isObject(value.retention)) fail('EVIDENCE_UNAVAILABLE');
    const readiness = value.readiness;
    if (!hasExactKeys(readiness, ['ready', 'analysisV2AdmissionEnabled', 'earlybirdWebhookAutoAdmissionEnabled'])
        || typeof readiness.ready !== 'boolean'
        || typeof readiness.analysisV2AdmissionEnabled !== 'boolean'
        || typeof readiness.earlybirdWebhookAutoAdmissionEnabled !== 'boolean') fail('EVIDENCE_UNAVAILABLE');
    assertRoleRecord<PreparationQueueObservation>(value.queues, item => isObject(item)
        && typeof item.resource === 'string' && SAFE_ATOM.test(item.resource)
        && (item.state === 'PAUSED' || item.state === 'RUNNING')
        && typeof item.empty === 'boolean' && typeof item.complete === 'boolean');
    assertRoleRecord<PreparationSchedulerObservation>(value.schedulers, item => isObject(item)
        && typeof item.resource === 'string' && SAFE_ATOM.test(item.resource)
        && (item.state === 'PAUSED' || item.state === 'ENABLED')
        && Number.isSafeInteger(item.pauseEpochMs) && (item.pauseEpochMs as number) >= 0
        && (item.lastAttemptMs === null || (Number.isSafeInteger(item.lastAttemptMs) && (item.lastAttemptMs as number) >= 0)));
    if (typeof value.retention.resource !== 'string' || !SAFE_ATOM.test(value.retention.resource) || typeof value.retention.enabled !== 'boolean') fail('EVIDENCE_UNAVAILABLE');
}

function assertReadinessClosed(observation: PreparationObservation): void {
    if (observation.readiness.ready !== true
        || observation.readiness.analysisV2AdmissionEnabled !== false
        || observation.readiness.earlybirdWebhookAutoAdmissionEnabled !== false) fail('EVIDENCE_UNAVAILABLE');
}

function assertQueueQuiescence(observation: PreparationObservation): void {
    for (const role of ROLES) {
        const queue = observation.queues[role];
        if (queue.state !== 'PAUSED' || queue.empty !== true || queue.complete !== true) fail('EVIDENCE_UNAVAILABLE');
    }
}

function assertSchedulerResourcesSeparate(observation: PreparationObservation): void {
    const resources = ROLES.map(role => observation.schedulers[role].resource);
    if (new Set(resources).size !== ROLES.length || resources.some(resource => resource === observation.retention.resource)) fail('IDENTITY_CONFLICT');
}

function assertQuiescenceMature(observation: PreparationObservation, nowMs: number, timeoutMs: number, graceMs: number, allowEnabled: boolean): void {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(graceMs) || graceMs < 0) fail('EVIDENCE_UNAVAILABLE');
    for (const role of ROLES) {
        const scheduler = observation.schedulers[role];
        if (scheduler.state === 'ENABLED' && allowEnabled) continue;
        if (scheduler.state !== 'PAUSED' || scheduler.pauseEpochMs <= 0 || scheduler.pauseEpochMs > nowMs) fail('QUIESCENCE_PENDING');
        if (nowMs - scheduler.pauseEpochMs < timeoutMs + graceMs
            || (scheduler.lastAttemptMs !== null && nowMs - scheduler.lastAttemptMs < timeoutMs + graceMs)) fail('QUIESCENCE_PENDING');
    }
}

function selectionInput(observation: PreparationObservation): IdentityGraphObservation {
    return {
        ...observation.identityGraph,
        schedulerStates: Object.fromEntries(ROLES.map(role => [role, observation.schedulers[role].state])) as Record<Role, 'PAUSED' | 'ENABLED'>,
        schedulerResources: Object.fromEntries(ROLES.map(role => [role, observation.schedulers[role].resource])) as Record<Role, string>,
        retentionSchedulerResource: observation.retention.resource,
    };
}

function buildProposal(observation: PreparationObservation, quiescence: PreparationOperatorOptions['quiescence'], nowMs: number): PreparationProposal {
    assertObservation(observation);
    assertReadinessClosed(observation);
    assertQueueQuiescence(observation);
    assertSchedulerResourcesSeparate(observation);
    const selection = selectDesiredIdentityGraph(selectionInput(observation));
    // Inspect does not require a scheduler that is currently enabled to be
    // mature. Apply invokes this gate again before the first mutation.
    const proposalDigest = canonicalDigest({ observation, preparation: canonicalPreparationProjection(selection) });
    const baseSummary = summarizePreparation(selection);
    const summary = Object.freeze({ ...baseSummary, discoveryDigest: proposalDigest });
    void quiescence;
    void nowMs;
    return Object.freeze({ observation, selection, discoveryDigest: proposalDigest, summary });
}

function buildCandidateDigest(observation: PreparationObservation): string {
    assertObservation(observation);
    const selection = selectDesiredIdentityGraph(selectionInput(observation));
    return canonicalDigest({ observation, preparation: canonicalPreparationProjection(selection) });
}

function sameDigest(left: string, right: string): boolean {
    return DIGEST.test(left) && left === right;
}

function validateAccountReadback(input: PreparationAccountCreateInput, value: IdentityAccountObservation): void {
    if (value.identity.identity !== input.identity.identity || value.identity.project !== input.identity.project
        || value.enabled !== true || value.userManagedKeyCount !== 0 || value.attachedSlots.length !== 0) fail('OBSERVATION_RACE');
}

function validateSchedulerReadback(input: Readonly<{ role: Role; resource: string }>, value: PreparationSchedulerObservation, nowMs: number): void {
    if (value.resource !== input.resource || value.state !== 'PAUSED'
        || !Number.isSafeInteger(value.pauseEpochMs) || value.pauseEpochMs <= 0 || value.pauseEpochMs > nowMs
        || (value.lastAttemptMs !== null && (!Number.isSafeInteger(value.lastAttemptMs) || value.lastAttemptMs < 0))) fail('OBSERVATION_RACE');
}

export class OwnerPreparationOperator {
    private readonly discoverPass: () => Promise<PreparationObservation>;
    private readonly mutate: PreparationMutator;
    private readonly now: () => number;
    private readonly timeoutMs: number;
    private readonly graceMs: number;

    constructor(options: PreparationOperatorOptions) {
        this.discoverPass = options.discover;
        this.mutate = options.mutate;
        this.now = options.now ?? (() => Date.now());
        this.timeoutMs = options.quiescence.timeoutMs;
        this.graceMs = options.quiescence.graceMs;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isSafeInteger(this.graceMs) || this.graceMs < 0) fail('ADAPTER_REQUEST_INVALID');
    }

    async inspect(): Promise<PreparationProposal> {
        let observation: PreparationObservation;
        try { observation = await this.discoverPass(); } catch (error) {
            if (error instanceof Error && error.name === 'EpochError') throw error;
            fail('EVIDENCE_UNAVAILABLE');
        }
        return buildProposal(observation, { timeoutMs: this.timeoutMs, graceMs: this.graceMs }, this.now());
    }

    async apply(approvedDigest: string): Promise<Readonly<{ status: 'PREPARED'; proposalDigest: string; createdAccounts: number; pausedSchedulers: number }>> {
        if (!DIGEST.test(approvedDigest)) fail('ADAPTER_REQUEST_INVALID');
        let freshObservation: PreparationObservation;
        try { freshObservation = await this.discoverPass(); } catch (error) {
            if (error instanceof Error && error.name === 'EpochError') throw error;
            fail('EVIDENCE_UNAVAILABLE');
        }
        let proposal: PreparationProposal;
        try {
            proposal = buildProposal(freshObservation, { timeoutMs: this.timeoutMs, graceMs: this.graceMs }, this.now());
        } catch (error) {
            // A changed gate/queue/resource is a stale proposal, not a reason
            // to run any partial mutation. Recompute only the in-memory
            // digest projection; no protected value leaves this boundary.
            try {
                if (buildCandidateDigest(freshObservation) !== approvedDigest) fail('PROPOSAL_STALE');
            } catch (candidateError) {
                if (candidateError instanceof Error && candidateError.name === 'EpochError') throw candidateError;
            }
            if (error instanceof Error && error.name === 'EpochError') throw error;
            fail('EVIDENCE_UNAVAILABLE');
        }
        if (!sameDigest(proposal.discoveryDigest, approvedDigest)) fail('PROPOSAL_STALE');
        const nowMs = this.now();
        // Enabled schedulers are an allowed pre-mutation state; already paused
        // schedulers must already have a mature no-attempt window. This check
        // prevents an account mutation from preceding an impossible pause.
        assertQuiescenceMature(proposal.observation, nowMs, this.timeoutMs, this.graceMs, true);
        for (const action of proposal.selection.actions) assertPreparationAction(action);
        if (!this.mutate || typeof this.mutate.createAccount !== 'function' || typeof this.mutate.readAccount !== 'function'
            || typeof this.mutate.pauseScheduler !== 'function' || typeof this.mutate.readScheduler !== 'function') fail('EVIDENCE_UNAVAILABLE');
        let createdAccounts = 0;
        let pausedSchedulers = 0;
        for (const action of proposal.selection.actions) {
            try {
                if (action.kind === 'account.create') {
                    await this.mutate.createAccount({ slot: action.slot, identity: action.identity });
                    validateAccountReadback({ slot: action.slot, identity: action.identity }, await this.mutate.readAccount({ identity: action.identity }));
                    createdAccounts += 1;
                    continue;
                }
                await this.mutate.pauseScheduler({ role: action.role, resource: action.resource });
                const readback = await this.mutate.readScheduler({ role: action.role, resource: action.resource });
                validateSchedulerReadback({ role: action.role, resource: action.resource }, readback, this.now());
                pausedSchedulers += 1;
            } catch (error) {
                if (error instanceof Error && error.name === 'EpochError') throw error;
                fail('EVIDENCE_UNAVAILABLE');
            }
        }
        // A just-paused scheduler is deliberately not treated as quiescent.
        // Return a fixed pending code without sleeping or resuming anything.
        const afterPause = await this.discoverPass();
        assertObservation(afterPause);
        assertReadinessClosed(afterPause);
        assertQueueQuiescence(afterPause);
        assertSchedulerResourcesSeparate(afterPause);
        assertQuiescenceMature(afterPause, this.now(), this.timeoutMs, this.graceMs, false);
        return Object.freeze({ status: 'PREPARED', proposalDigest: proposal.discoveryDigest, createdAccounts, pausedSchedulers });
    }
}

export type PreparationEpochProposal = Readonly<{
    packetDigest: string;
    bootstrapDigest: string;
    scopeDigest: string;
    identityGraphDigest: string;
    proposalDigest: string;
}>;
