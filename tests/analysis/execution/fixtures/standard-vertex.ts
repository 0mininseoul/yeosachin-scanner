type Generation = {
    contents: { parts: { text?: string }[] } | { parts: { text?: string }[] }[];
    config: { responseJsonSchema: { properties: Record<string, unknown> } };
};

export function syntheticGeneration(input: Generation) {
    const schema = input.config.responseJsonSchema.properties;
    const contents = Array.isArray(input.contents) ? input.contents : [input.contents];
    const prompt = contents
        .flatMap((content) => content.parts)
        .map((p) => p.text ?? '')
        .join('\n');
    const match = (pattern: RegExp) => {
        const value = prompt.match(pattern)?.[0];
        if (!value) throw new Error('Missing synthetic prompt reference ' + pattern.source);
        return value;
    };
    let output;
    if ('accounts' in schema) {
        const accountId = match(/account:[a-f0-9]{64}/);
        const evidence = 'batch-media:' + accountId.slice(-16) + ':1';
        const ids = [evidence, 'batch-media:' + accountId.slice(-16) + ':2'];
        output = {
            accounts: [
                {
                    accountId,
                    status: 'ok',
                    accountContext: 'personal',
                    assessment: {
                        inferredGender: 'female',
                        confidence: 'high',
                        ownerConsistency: 'same_person',
                        evidenceSelectionIds: ids,
                    },
                },
            ],
        };
    } else if ('inferredGender' in schema) {
        output = {
            inferredGender: 'female',
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: ['post:201:thumbnail'],
        };
    } else if ('gender' in schema) {
        const profile = match(/profile:[^"\s,\]]+/);
        const post = match(/post:201:thumbnail/);
        output = {
            gender: 'female',
            genderConfidence: 'high',
            ownerConsistency: 'same_person',
            appearanceGrade: 5,
            exposureScore: 2,
            businessClassification: 'personal',
            businessConfidence: 'high',
            accountContext: 'personal',
            marriageEvidence: 'none',
            partnerEvidence: 'none',
            partnerExclusionContext: 'none',
            evidenceSelectionIds: {
                gender: [profile, post],
                appearance: [post],
                exposure: [post],
                business: [profile],
                accountContext: [profile],
                marriagePartner: [],
            },
            oneLineOverview:
                '여행 사진마다 일상의 작은 표정까지 담아내는 모습에서 차분히 추억을 기록하는 취향이 드러납니다.',
        };
    } else if ('companionPattern' in schema) {
        output = {
            companionPattern: 'none',
            partnerEvidence: 'none',
            exclusionContext: 'none',
            confidence: 'high',
            evidenceSourceSelectionIds: [],
        };
    } else if ('lines' in schema) {
        // Deliberately return valid wire JSON with incomplete evidence. The v2.11 worker
        // must ground its repaired narrative in the saved names and observed interactions.
        output = {
            lines: [
                { text: 'sample2님의 피드에 여행 장면이 담겼습니다.', evidenceRefs: ['profile:bio'] },
                {
                    text: 'sample2님이 target7님에게 남긴 댓글이 보입니다.',
                    evidenceRefs: ['coverage:target-interactions'],
                },
            ],
        };
    } else {
        throw new Error('Unexpected synthetic Vertex schema ' + Object.keys(schema).join(','));
    }
    const text = JSON.stringify(output);
    return {
        text,
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
        usageMetadata: {
            promptTokenCount: 24,
            candidatesTokenCount: 12,
            thoughtsTokenCount: 0,
            totalTokenCount: 36,
        },
    };
}
