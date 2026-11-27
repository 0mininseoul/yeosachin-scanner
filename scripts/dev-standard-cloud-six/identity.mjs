// Run only in the operator's private, one-task Dev Cloud Run Job.
// Supabase Auth generates the six user IDs. The script never prints them.
import assert from 'node:assert/strict';

const devOrigin = 'https://bgamojfpkxnnumfvkron.supabase.co';
const project = 'gen-lang-client-0311522474';

export function buyerIdentity(wave, slot) {
    assert.match(wave, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 6);
    return {
        email: 'dev-six-' + wave.slice(0, 16) + '-' + slot + '@example.invalid',
        app_metadata: { dev_cloud_six_v1: wave, dev_cloud_six_slot: slot },
    };
}

async function provision() {
    const wave = process.env.DEV_STANDARD_QA_WAVE;
    const admin = process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.equal(process.env.CLOUD_RUN_JOB, 'dev-standard-six-identity');
    assert.equal(process.env.GOOGLE_CLOUD_PROJECT, project);
    assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, devOrigin);
    assert.match(wave ?? '', /^[0-9a-f]{64}$/);
    assert.ok(admin && Number(process.env.CLOUD_RUN_TASK_INDEX) === 0 && Number(process.env.CLOUD_RUN_TASK_COUNT) === 1);
    let created = 0, alreadyPresent = 0;
    for (let i = 1; i <= 6; i++) {
        const account = buyerIdentity(wave,i);
        const res = await fetch(devOrigin + '/auth/v1/admin/users', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
            headers: { apikey: admin, Authorization: 'Bearer '+admin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...account, email_confirm: true }),
        });
        const row = await res.json();
        if (!res.ok) {
            if ((res.status === 422 || res.status === 400) && [row.error_code, row.code].some(code => code === 'email_exists' || code === 'user_already_exists')) {
                // open_v1 independently verifies all six Auth identities before registration.
                alreadyPresent++; continue;
            }
            throw new Error('SYNTHETIC_AUTH_CREATE_' + res.status + '_SLOT_' + i);
        }
        if (row.email !== account.email || row.app_metadata?.dev_cloud_six_v1 !== wave
            || row.app_metadata?.dev_cloud_six_slot !== i || row.app_metadata?.provider !== 'email') {
            throw new Error('SYNTHETIC_AUTH_RETURNED_UNEXPECTED_PRINCIPAL');
        }
        created++;
    }
    console.log(JSON.stringify({action:'provision-synthetic-buyers', created, alreadyPresent, total:created+alreadyPresent}));
}

// This file is also imported by the Dev-only result verifier.
if (process.argv[1]?.endsWith('/identity.mjs') || process.env.DEV_STANDARD_QA_IDENTITY_ENTRY === 'provision') {
    provision().catch(error => {
        console.error(/^SYNTHETIC_AUTH_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'SYNTHETIC_AUTH_PROVISION_FAILED');
        process.exitCode = 1;
    });
}
