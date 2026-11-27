export function standardModelStage(input) {
    const schema = input?.config?.responseJsonSchema;
    const fields = schema?.properties ?? {};
    if ('femaleScore' in (schema?.items?.properties ?? {})) return 'private_names';
    if (schema?.type?.toLowerCase() === 'array') return 'name_only';
    for (const [key, stage] of Object.entries({accounts:'gender_triage',gender:'features',inferredGender:'resolver',
        companionPattern:'partner',lines:'narrative',persona:'preview'})) if (key in fields) return stage;
    return 'unknown';
}
