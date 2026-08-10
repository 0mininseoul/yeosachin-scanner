import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    parseAccountLedgerRolloutArgs,
    runAccountLedgerRollout,
    type AccountLedgerAuthAdmin,
    type AccountLedgerClient,
    type AccountLedgerKeychain,
} from './account-ledger-rollout';

const execFile = promisify(execFileCallback);
const KEYCHAIN_SERVICE = 'ai-baram-detector.account-ledger';
const MAX_AUTH_LOOKUP_PAGES = 10;
const AUTH_LOOKUP_PAGE_SIZE = 1_000;

function fail(code: string): never {
    throw new Error(code);
}

function singleRow(value: unknown): Record<string, unknown> {
    if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object') {
        fail('ACCOUNT_LEDGER_RPC_RESULT_INVALID');
    }
    return value[0] as Record<string, unknown>;
}

function boundedCount(value: unknown): number {
    if (
        typeof value !== 'number'
        || !Number.isInteger(value)
        || value < 0
        || value > 100_000
    ) {
        fail('ACCOUNT_LEDGER_RPC_RESULT_INVALID');
    }
    return value;
}

function uuid(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        fail('ACCOUNT_LEDGER_RPC_RESULT_INVALID');
    }
    return value.toLowerCase();
}

function appMetadata(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('ACCOUNT_LEDGER_AUTH_RESULT_INVALID');
    }
    return value as Record<string, unknown>;
}

const keychain: AccountLedgerKeychain = {
    async read(account) {
        try {
            const result = await execFile('/usr/bin/security', [
                'find-generic-password', '-w', '-s', KEYCHAIN_SERVICE, '-a', account,
            ], { maxBuffer: 8_192 });
            return result.stdout.replace(/\r?\n$/, '');
        } catch {
            return null;
        }
    },
    async write(account, value) {
        try {
            await execFile('/usr/bin/security', [
                'add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', value,
            ], { maxBuffer: 8_192 });
        } catch {
            fail('ACCOUNT_LEDGER_KEYCHAIN_WRITE_FAILED');
        }
    },
};

const ledger: AccountLedgerClient = {
    async getRolloutState() {
        const { data, error } = await supabaseAdmin.rpc('load_account_ledger_rollout_state_v1');
        if (error) fail('ACCOUNT_LEDGER_RPC_FAILED');
        const row = singleRow(data);
        if (
            (row.paid_ever_state !== 'pending' && row.paid_ever_state !== 'active')
            || (row.classification_command_version !== null
                && typeof row.classification_command_version !== 'string')
        ) fail('ACCOUNT_LEDGER_RPC_RESULT_INVALID');
        return {
            state: row.paid_ever_state,
            commandVersion: row.classification_command_version,
        };
    },
    async listLegacyE2eCandidateIds() {
        const { data, error } = await supabaseAdmin.rpc(
            'list_account_ledger_legacy_e2e_candidates_v1',
        );
        if (error || !Array.isArray(data)) fail('ACCOUNT_LEDGER_RPC_FAILED');
        return data.map(row => {
            if (!row || typeof row !== 'object') fail('ACCOUNT_LEDGER_RPC_RESULT_INVALID');
            return uuid((row as Record<string, unknown>).account_id);
        });
    },
    async buildClassificationPlan(input) {
        const { data, error } = await supabaseAdmin.rpc(
            'build_account_ledger_classification_plan_v1',
            {
                p_legacy_candidate_ids: input.legacyCandidateIds,
                p_operator_account_ids: input.operatorAccountIds,
                p_internal_tester_account_ids: input.internalTesterAccountIds,
            },
        );
        if (error) fail('ACCOUNT_LEDGER_RPC_FAILED');
        const row = singleRow(data);
        if (!Array.isArray(row.assignments)) fail('ACCOUNT_LEDGER_RPC_RESULT_INVALID');
        return {
            assignments: row.assignments as readonly Record<string, unknown>[],
            totalCount: boundedCount(row.total_count),
            legacyE2eCount: boundedCount(row.legacy_e2e_count),
            operatorCount: boundedCount(row.operator_count),
            internalTesterCount: boundedCount(row.internal_tester_count),
            productionExternalCount: boundedCount(row.production_external_count),
        };
    },
    async applyClassificationPlan(input) {
        const { data, error } = await supabaseAdmin.rpc('classify_account_principals_v1', {
            p_assignments: input.assignments,
            p_command_version: input.commandVersion,
            p_activate_paid_ever: input.activatePaidEver,
        });
        if (error) fail('ACCOUNT_LEDGER_RPC_FAILED');
        const row = singleRow(data);
        return {
            updatedCount: boundedCount(row.updated_count),
            evidenceCount: boundedCount(row.evidence_count),
            paidAccountCount: boundedCount(row.paid_account_count),
        };
    },
    async provisionRunner(input) {
        const { data, error } = await supabaseAdmin.rpc('provision_e2e_test_runner_v1', {
            p_user_id: input.userId,
            p_email: input.email,
            p_runner_plan: input.runnerPlan,
            p_command_version: input.commandVersion,
        });
        if (error) fail('ACCOUNT_LEDGER_RPC_FAILED');
        const row = singleRow(data);
        if (
            (row.runner_plan !== 'basic' && row.runner_plan !== 'standard')
            || typeof row.created !== 'boolean'
        ) fail('ACCOUNT_LEDGER_RPC_RESULT_INVALID');
        return { runnerPlan: row.runner_plan, created: row.created };
    },
    async listRunnerPlans() {
        const { data, error } = await supabaseAdmin.rpc('list_e2e_test_runner_plans_v1');
        if (error || !Array.isArray(data)) fail('ACCOUNT_LEDGER_RPC_FAILED');
        return data.map(row => {
            const plan = row && typeof row === 'object'
                ? (row as Record<string, unknown>).runner_plan
                : null;
            if (plan !== 'basic' && plan !== 'standard') fail('ACCOUNT_LEDGER_RPC_RESULT_INVALID');
            return plan;
        });
    },
};

function authUser(value: unknown): { id: string; appMetadata: Record<string, unknown> } {
    if (!value || typeof value !== 'object') fail('ACCOUNT_LEDGER_AUTH_RESULT_INVALID');
    const user = value as Record<string, unknown>;
    return { id: uuid(user.id), appMetadata: appMetadata(user.app_metadata) };
}

const auth: AccountLedgerAuthAdmin = {
    async createUser(input) {
        const { data, error } = await supabaseAdmin.auth.admin.createUser({
            email: input.email,
            password: input.password,
            email_confirm: true,
            app_metadata: input.appMetadata,
        });
        if (error || !data.user) fail('ACCOUNT_LEDGER_E2E_RUNNER_AUTH_CREATE_FAILED');
        return authUser(data.user);
    },
    async getUser(userId) {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (error) return null;
        return data.user ? authUser(data.user) : null;
    },
    async findUserByEmail(email) {
        let matches: { id: string; appMetadata: Record<string, unknown> }[] = [];
        for (let page = 1; page <= MAX_AUTH_LOOKUP_PAGES; page += 1) {
            const { data, error } = await supabaseAdmin.auth.admin.listUsers({
                page,
                perPage: AUTH_LOOKUP_PAGE_SIZE,
            });
            if (error || !data || !Array.isArray(data.users)) {
                fail('ACCOUNT_LEDGER_E2E_RUNNER_AUTH_LOOKUP_FAILED');
            }
            matches = matches.concat(data.users
                .filter(user => user.email === email)
                .map(authUser));
            if (data.users.length < AUTH_LOOKUP_PAGE_SIZE) break;
        }
        if (matches.length > 1) fail('ACCOUNT_LEDGER_E2E_RUNNER_AUTH_LOOKUP_AMBIGUOUS');
        return matches[0] ?? null;
    },
};

async function main(): Promise<void> {
    const args = parseAccountLedgerRolloutArgs(process.argv.slice(2));
    await runAccountLedgerRollout(args, {
        keychain,
        ledger,
        auth,
        report: value => process.stdout.write(`${JSON.stringify(value)}\n`),
    });
}

void main().catch(() => {
    // Never forward SDK, Keychain, Auth, or database error messages: each may
    // contain identifiers, credentials, HMAC material, or raw candidate rows.
    process.stderr.write('ACCOUNT_LEDGER_ROLLOUT_FAILED\n');
    process.exitCode = 1;
});
