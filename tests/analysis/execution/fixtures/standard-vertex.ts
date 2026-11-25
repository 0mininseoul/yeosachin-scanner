import { z } from 'zod';
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
    includeResolverCandidates = false,
) {
    const schema = input.config.responseJsonSchema.properties;
    const contents = Array.isArray(input.contents) ? input.contents : [input.contents];
    const prompt = contents
        .flatMap((content) => content.parts)
        .map((p) => p.text ?? '')
        .join('\n');
    const manifest = z.array(z.object({ selectionId: z.string().min(1), kind: z.enum(['profile', 'feed']) })).min(1);
    function data(label: string): unknown {
        const prefix = label + '(JSON): ';
        const line = prompt.split('\n').findLast(row => row.startsWith(prefix));
        if (!line) throw new Error('Missing synthetic prompt manifest for ' + label);
        return JSON.parse(line.slice(prefix.length));
    }
    let output;
    const privateNames = fixedPrivateNameResults(input);
    if (privateNames) {
        output = privateNames;
    } else if ('persona' in schema) {
        output = validModelResponse();
    } else if ('accounts' in schema) {
        const accounts = z.array(z.object({ accountId: z.string(), mediaManifest: manifest })).min(1).parse(data('accounts'));
        output = { accounts: accounts.map(({ accountId, mediaManifest }, index) => ({
            accountId, status: 'ok', accountContext: 'personal',
            assessment: { inferredGender: triageGender, confidence: includeResolverCandidates && index % 4 === 0 ? 'medium' : 'high', ownerConsistency: 'same_person',
                evidenceSelectionIds: mediaManifest.slice(0, 2).map(item => item.selectionId) },
        })) };
    } else if ('inferredGender' in schema) {
        // Optional single-account resolution uses anonymous image aliases. The single-account
        // triage stage instead supplies its own selection manifest.
        const allowed = prompt.split('\n').find(line => line.startsWith('사용 가능한 selectionId: '));
        const choices = allowed
            ? allowed.slice('사용 가능한 selectionId: '.length).split(', ').filter(Boolean)
            : manifest.parse(data('mediaManifest')).map(item => item.selectionId);
        if (!choices.length) throw new Error('Missing synthetic resolution evidence');
        output = {
            inferredGender: triageGender,
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: [choices.find(id => id.startsWith('post:')) ?? choices[0]],
        };
    } else if ('gender' in schema) {
        const { mediaManifest } = z.object({ mediaManifest: manifest }).parse(data('evidence'));
        const profile = mediaManifest.find(item => item.kind === 'profile')?.selectionId;
        const post = mediaManifest.find(item => item.kind === 'feed')?.selectionId;
        if (!profile || !post) throw new Error('Synthetic feature fixture requires its own profile and feed evidence');
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
