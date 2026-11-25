import { validModelResponse } from '../../../commerce/precheckout/fixtures/blite-model';

type Generation = {
    contents: { parts: { text?: string; inlineData?: { data?: string } }[] } | { parts: { text?: string; inlineData?: { data?: string } }[] }[];
    config: { responseJsonSchema: { properties: Record<string, unknown> } };
};

/** Return neutral answers in the private-name stage's exact input order. */
export function fixedPrivateNameResults(input: Generation) {
    const schema = input.config.responseJsonSchema as { type?: string; items?: { properties?: Record<string, unknown> } };
    if (schema.type?.toLowerCase() !== 'array' || !schema.items?.properties || !('femaleScore' in schema.items.properties)) return null;
    const contents = Array.isArray(input.contents) ? input.contents : [input.contents];
    const prompt = contents.flatMap(content => content.parts).map(part => part.text ?? '').join('\n');
    const marker = '\n입력 JSON:\n';
    const offset = prompt.lastIndexOf(marker);
    if (offset < 0) throw new Error('OFFLINE_STANDARD_VERTEX_PROMPT_SHAPE');
    const rows: unknown = JSON.parse(prompt.slice(offset + marker.length));
    if (!Array.isArray(rows) || !rows.every(row => row && typeof row.id === 'string'))
        throw new Error('OFFLINE_STANDARD_VERTEX_MODEL_INPUT_SHAPE');
    return rows.map(row => ({ id: row.id, femaleScore: 0.5, isName: false, confidence: 0 }));
}

export function syntheticGeneration(
    input: Generation,
    triageGender: 'female' | 'male' = 'female',
    featureGender: 'female' | 'male' = 'female',
) {
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
    const privateNames = fixedPrivateNameResults(input);
    if (privateNames) {
        output = privateNames;
    } else if ('persona' in schema) {
        output = validModelResponse();
    } else if ('accounts' in schema) {
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
                        inferredGender: triageGender,
                        confidence: 'high',
                        ownerConsistency: 'same_person',
                        evidenceSelectionIds: ids,
                    },
                },
            ],
        };
    } else if ('inferredGender' in schema) {
        output = {
            inferredGender: triageGender,
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: ['post:201:thumbnail'],
        };
    } else if ('gender' in schema) {
        const profile = match(/profile:[^"\s,\]]+/);
        const post = match(/post:201:thumbnail/);
        output = {
            gender: featureGender,
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
                '프로필 이미지와 피드 이미지가 함께 있어 소개 화면과 게시물 양쪽에서 사진을 볼 수 있습니다.',
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
