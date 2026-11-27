// Each run leaves its previous queue paused with the original delivery history.
export function queueName(role, wave) {
    if (!['paid', 'preflight'].includes(role) || typeof wave !== 'string' || !/^[a-f0-9]{64}$/.test(wave))
        throw new Error('DEV_STANDARD_QA_QUEUE_SCOPE_INVALID');
    return 'dev-standard-qa-' + role + '-' + wave.slice(0, 16);
}
