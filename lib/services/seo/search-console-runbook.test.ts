import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RUNBOOK_URL = new URL(
    '../../../docs/seo-geo-search-console-runbook.md',
    import.meta.url,
);
const REQUIRED_DEPLOYMENT_URLS = [
    'https://yeosachin.com/robots.txt',
    'https://yeosachin.com/sitemap.xml',
    'https://yeosachin.com/',
    'https://yeosachin.com/guide/wijang-yeosachin',
    'https://yeosachin.com/terms',
    'https://yeosachin.com/privacy',
] as const;

function readRunbook(): string {
    expect(
        existsSync(RUNBOOK_URL),
        'Search Console 운영 런북이 있어야 합니다.',
    ).toBe(true);
    return readFileSync(RUNBOOK_URL, 'utf8');
}

function readSection(markdown: string, heading: string): string {
    const lines = markdown.split('\n');
    const start = lines.findIndex(line => line.trim() === heading);
    expect(start, `${heading} 섹션이 있어야 합니다.`).toBeGreaterThanOrEqual(0);
    if (start < 0) return '';

    const level = heading.match(/^#+/)?.[0].length ?? 0;
    const nextHeading = new RegExp(`^#{1,${level}}\\s`);
    const relativeEnd = lines.slice(start + 1).findIndex(line => nextHeading.test(line));
    const end = relativeEnd < 0 ? lines.length : start + relativeEnd + 1;
    return lines.slice(start, end).join('\n');
}

function prerequisiteIssues(section: string): string[] {
    const body = section.replace(/^##[^\n]*\n?/, '').trim();
    const lines = body.split('\n');
    const issues: string[] = [];
    if (!body) issues.push('empty');

    const hasAffirmativeLogin = lines.some(line => (
        /Google[^\n]*(계정|account)/i.test(line)
        && /Search Console/i.test(line)
        && /(로그인할 수 있어야|로그인할 수 있는|로그인(?:이 )?가능|로그인 권한|can sign in|sign-in access)/i
            .test(line)
        && !/(로그인|sign in|sign-in)[^\n]*(없|않|못|불가|cannot|can't)|읽기\s*전용|read[- ]?only/i
            .test(line)
    ));
    if (!hasAffirmativeLogin) {
        issues.push('google-account-sign-in');
    }

    const hasDnsEditAbility = lines.some(line => (
        /yeosachin\.com/i.test(line)
        && /DNS/i.test(line)
        && /TXT/i.test(line)
        && (
            /(추가|수정|편집|변경)[^\n]*(권한|가능|할 수 있어야|할 수 있는)/i.test(line)
            || /(권한|가능|할 수 있어야|할 수 있는)[^\n]*(추가|수정|편집|변경)/i.test(line)
        )
        && !/(읽기\s*(?:접근|전용)|read[- ]?only|(?:추가|수정|편집|변경|권한)[^\n]*(없|않|못|불가|cannot|can't)|권한만)/i
            .test(line)
    ));
    if (!hasDnsEditAbility) {
        issues.push('dns-txt-edit-access');
    }

    const requiresVerifiedOwner = lines.some(line => (
        /(확인된|verified)[^\n]*(소유자|owner)[^\n]*(권한|access)/i.test(line)
        && /(준비|필요|요구|있어야|갖추|필수)/i.test(line)
        && !/(요구|필요|준비|필수)[^\n]*(하지|않|없|아니)|없어도|불필요/i.test(line)
    ));
    if (requiresVerifiedOwner) {
        issues.push('circular-verified-owner');
    }
    if (
        !/(배포|프로덕션)[^\n]*(HTTP|엔드포인트|endpoint)[^\n]*(응답|response)[^\n]*(확인|검사|inspect)/i
            .test(body)
    ) {
        issues.push('deployed-response-inspection');
    }
    return issues;
}

interface DeploymentRow {
    expected: string;
    url: string;
}

function readDeploymentRows(section: string): DeploymentRow[] {
    const lines = section.split('\n');
    const header = lines.findIndex(line => /^\|\s*URL\s*\|\s*기대 결과\s*\|$/.test(line));
    if (
        header < 0
        || !/^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/.test(lines[header + 1] ?? '')
    ) {
        return [];
    }

    const rows: DeploymentRow[] = [];
    for (const line of lines.slice(header + 2)) {
        if (!line.startsWith('|')) break;
        const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
        if (cells.length !== 2) continue;
        rows.push({
            url: cells[0]?.replace(/^`|`$/g, '') ?? '',
            expected: cells[1] ?? '',
        });
    }
    return rows;
}

function deploymentTableIssues(section: string): string[] {
    const rows = readDeploymentRows(section);
    const issues: string[] = [];

    if (rows.length !== REQUIRED_DEPLOYMENT_URLS.length) {
        issues.push('row-count');
    }

    for (const url of REQUIRED_DEPLOYMENT_URLS) {
        const matches = rows.filter(row => row.url === url);
        if (matches.length !== 1) {
            issues.push(`${url}:row`);
            continue;
        }

        const expected = matches[0]?.expected ?? '';
        if (!expected) issues.push(`${url}:expected`);
        if (!/(?:HTTP\s*)?200/i.test(expected)) issues.push(`${url}:200`);

        if (url.endsWith('/robots.txt')) {
            if (!/Googlebot/i.test(expected)) issues.push(`${url}:googlebot`);
            if (!/OAI-SearchBot/i.test(expected)) issues.push(`${url}:oai-searchbot`);
            if (!/(공개|public)[^\n]*(허용|크롤링할 수)/i.test(expected)) {
                issues.push(`${url}:public-crawl-policy`);
            }
            if (!expected.includes('https://yeosachin.com/sitemap.xml')) {
                issues.push(`${url}:absolute-sitemap`);
            }
            continue;
        }

        if (url.endsWith('/sitemap.xml')) {
            if (!/(유효한[^\n]*XML|XML[^\n]*유효)/i.test(expected)) {
                issues.push(`${url}:valid-xml`);
            }
            if (!/(정확히|exactly)[^\n]*(공개|public)|(공개|public)[^\n]*(정확히|exactly)/i.test(expected)) {
                issues.push(`${url}:exact-public-urls`);
            }
            for (const canonicalUrl of REQUIRED_DEPLOYMENT_URLS.slice(2)) {
                if (!expected.includes(canonicalUrl)) {
                    issues.push(`${url}:canonical:${canonicalUrl}`);
                }
            }
            continue;
        }

        if (!expected.includes(url) || !/canonical/i.test(expected)) {
            issues.push(`${url}:self-canonical`);
        }
        if (!/noindex[^\n]*(없|아님|미설정|제거)/i.test(expected)) {
            issues.push(`${url}:indexable`);
        }
    }

    return issues;
}

describe('SEO/GEO Search Console operations runbook', () => {
    it('is a Korean runbook with prerequisites and a scoped deployment URL table', () => {
        const runbook = readRunbook();

        expect(runbook).toMatch(/^# (?=[^\n]*[가-힣])[^\n]+\n/);
        expect(runbook).toMatch(/^## \d*\.?\s*사전 준비\s*$/m);
        const prerequisites = readSection(runbook, '## 사전 준비');
        expect(prerequisiteIssues(prerequisites)).toEqual([]);

        const emptyPrerequisites = '## 사전 준비\n\n';
        expect(prerequisiteIssues(emptyPrerequisites)).toEqual([
            'empty',
            'google-account-sign-in',
            'dns-txt-edit-access',
            'deployed-response-inspection',
        ]);
        const circularPrerequisites = [
            '## 사전 준비',
            '',
            '- Google Search Console에서 확인된 소유자 권한을 준비한다.',
            '- 배포 후보의 HTTP 응답을 확인할 수 있어야 한다.',
        ].join('\n');
        expect(prerequisiteIssues(circularPrerequisites)).toEqual([
            'google-account-sign-in',
            'dns-txt-edit-access',
            'circular-verified-owner',
        ]);
        const validDnsAndDeployment = [
            '- `yeosachin.com` DNS TXT 레코드를 추가·수정할 권한을 준비한다.',
            '- 배포 후보의 HTTP 응답을 확인할 수 있어야 한다.',
        ];
        for (const negatedLogin of [
            '- Google 계정으로 Search Console에 로그인할 수 없다.',
            '- Google 계정은 Search Console 읽기 전용이며 로그인 권한이 없다.',
        ]) {
            expect(prerequisiteIssues([
                '## 사전 준비',
                '',
                negatedLogin,
                ...validDnsAndDeployment,
            ].join('\n'))).toEqual(['google-account-sign-in']);
        }
        const validLoginAndDeployment = [
            '- Google 계정으로 Search Console에 로그인할 수 있어야 한다.',
            '- 배포 후보의 HTTP 응답을 확인할 수 있어야 한다.',
        ];
        for (const insufficientDnsAccess of [
            '- `yeosachin.com` DNS TXT 레코드에 읽기 접근 권한만 준비한다.',
            '- `yeosachin.com` DNS TXT 레코드 접근 권한을 준비한다.',
        ]) {
            expect(prerequisiteIssues([
                '## 사전 준비',
                '',
                ...validLoginAndDeployment,
                insufficientDnsAccess,
            ].join('\n'))).toEqual(['dns-txt-edit-access']);
        }
        for (const warning of [
            '- 확인된 소유자 권한을 요구하지 않는다.',
            '- 확인된 소유자 권한은 필요 없다.',
        ]) {
            const negatedCircularWarning = [
                '## 사전 준비',
                '',
                '- Google 계정으로 Search Console에 로그인할 수 있어야 한다.',
                '- `yeosachin.com` DNS TXT 레코드를 변경할 권한을 준비한다.',
                warning,
                '- 배포 후보의 HTTP 응답을 확인할 수 있어야 한다.',
            ].join('\n');
            expect(prerequisiteIssues(negatedCircularWarning)).toEqual([]);
        }

        const deployment = readSection(runbook, '## 1. 배포 전·후 URL 확인');
        expect(deployment).toMatch(
            /^\|\s*URL\s*\|\s*기대 결과\s*\|\n\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/m,
        );
        for (const url of REQUIRED_DEPLOYMENT_URLS) {
            expect(deployment).toMatch(
                new RegExp(`^\\|[^\\n]*${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\|$`, 'm'),
            );
        }
        expect(deploymentTableIssues(deployment)).toEqual([]);

        const emptyHomeExpectation = deployment
            .split('\n')
            .map(line => line.startsWith('| `https://yeosachin.com/` |')
                ? '| `https://yeosachin.com/` | |'
                : line)
            .join('\n')
            + '\n\nHTTP 200, canonical은 https://yeosachin.com/이다.';
        expect(deploymentTableIssues(emptyHomeExpectation)).toEqual(
            expect.arrayContaining([
                'https://yeosachin.com/:expected',
                'https://yeosachin.com/:200',
                'https://yeosachin.com/:self-canonical',
                'https://yeosachin.com/:indexable',
            ]),
        );
        expect(deployment).toMatch(/배포 전[^\n]*(확인|검사|검증)/);
        expect(deployment).toMatch(/배포 후[^\n]*(확인|검사|검증|실행)/);
    });

    it('documents deployment verification and Domain property ownership', () => {
        const runbook = readRunbook();

        expect(runbook).toMatch(/yeosachin\.com[\s\S]{0,100}Domain property/i);
        expect(runbook).toMatch(/DNS[\s\S]{0,80}TXT[\s\S]{0,100}(소유권|ownership)/i);
        expect(runbook).toMatch(/배포 전[\s\S]{0,1000}배포 후/);

        for (const url of [
            'https://yeosachin.com/robots.txt',
            'https://yeosachin.com/sitemap.xml',
            'https://yeosachin.com/',
            'https://yeosachin.com/guide/wijang-yeosachin',
        ]) {
            expect(runbook).toContain(url);
        }
        expect(runbook).toMatch(/robots\.txt[^\n]*200/i);
        expect(runbook).toMatch(/sitemap\.xml[^\n]*200/i);
        expect(runbook).toMatch(/https:\/\/yeosachin\.com\/[^\n]*200[^\n]*canonical/i);
        expect(runbook).toMatch(
            /https:\/\/yeosachin\.com\/guide\/wijang-yeosachin[^\n]*200[^\n]*canonical/i,
        );
    });

    it('documents Search generative AI inclusion and its rollout caveats', () => {
        const runbook = readRunbook();

        expect(runbook).toContain('설정 → Search generative AI');
        expect(runbook).toMatch(
            /(포함|include)[^\n]*(선택|설정|유지)|사이트를 Google의 생성형 AI 기능에 포함/i,
        );
        expect(runbook).toMatch(/기본[^\n]*(포함|include)/i);
        expect(runbook).toMatch(/(일부|subset|순차|rollout|출시)[^\n]*(제공|노출|계정|속성)/i);
    });

    it('documents sitemap, live URL inspection, indexing, and canonical checks', () => {
        const runbook = readRunbook();

        expect(runbook).toMatch(
            /https:\/\/yeosachin\.com\/sitemap\.xml[\s\S]{0,300}(제출|submit)[\s\S]{0,200}(성공|success)/i,
        );
        for (const url of [
            'https://yeosachin.com/',
            'https://yeosachin.com/guide/wijang-yeosachin',
        ]) {
            const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            expect(runbook).toMatch(
                new RegExp(`${escaped}[\\s\\S]{0,500}(실시간 URL 테스트|live URL test)[\\s\\S]{0,300}(색인 생성 요청|request indexing)`, 'i'),
            );
        }
        expect(runbook).toMatch(/사용자 선언 표준 URL|user-declared canonical/i);
        expect(runbook).toMatch(/Google 선택 표준 URL|Google-selected canonical/i);

        const inspection = readSection(
            runbook,
            '## 5. URL Inspection, 실시간 테스트, 색인 요청',
        );
        expect(inspection).toMatch(
            /사용자 선언 표준 URL[^\n]{0,240}Google에서 선택한 표준 URL[^\n]{0,240}(비교|일치)|Google에서 선택한 표준 URL[^\n]{0,240}사용자 선언 표준 URL[^\n]{0,240}(비교|일치)/,
        );
    });

    it('documents Search, generative AI, and safe ChatGPT referral measurement', () => {
        const runbook = readRunbook();

        for (const query of [
            '위장여사친 판독기',
            '위장여사친 구분법',
        ]) {
            expect(runbook).toContain(query);
        }
        expect(runbook).toMatch(/띄어쓰기[^\n]*(변형|variant)/i);
        expect(runbook).toMatch(
            /(Generative AI performance|생성형 AI 성과)[\s\S]{0,300}(AI Overviews|AI 개요)[\s\S]{0,200}AI Mode/i,
        );
        expect(runbook).toMatch(
            /(보고서|report)[^\n]*(없|미제공|unavailable|노출되지)[^\n]*(출시|rollout|노출|impression|데이터)/i,
        );
        expect(runbook).toContain('source=chatgpt');
        expect(runbook).toContain('medium=referral');
        expect(runbook).toMatch(/utm_source=chatgpt\.com[\s\S]{0,200}(OpenAI|ChatGPT)/i);

        const regularPerformance = readSection(runbook, '### 일반 Search Performance');
        for (const query of [
            '위장여사친 판독기',
            '위장 여사친 판독기',
            '위장여사친 구분법',
            '위장 여사친 구분법',
        ]) {
            expect(regularPerformance).toContain(query);
        }

        const generativePerformance = readSection(runbook, '### Google 생성형 AI 성과');
        expect(generativePerformance).toMatch(/AI Overviews|AI 개요/i);
        expect(generativePerformance).toMatch(/AI Mode/i);
        expect(generativePerformance).toMatch(
            /(rollout|순차|일부)[^\n]*(없|미제공|제공되지|노출되지)|(없|미제공|제공되지|노출되지)[^\n]*(rollout|순차|일부)/i,
        );
        expect(generativePerformance).toMatch(
            /(노출|impression)[^\n]*(부족|충분하지|낮)|(부족|충분하지|낮)[^\n]*(노출|impression)/i,
        );

        const amplitude = readSection(runbook, '### ChatGPT 추천 유입과 Amplitude');
        expect(amplitude).toContain('source=chatgpt');
        expect(amplitude).toContain('medium=referral');
    });

    it('documents observation cadence, troubleshooting, non-guarantees, and official sources', () => {
        const runbook = readRunbook();

        expect(runbook).toContain('7/28/90일');
        for (const cadence of ['### 7일', '### 28일', '### 90일']) {
            expect(runbook).toContain(cadence);
        }
        expect(runbook).toMatch(/보고서[^\n]*(없|미제공|노출되지)/);
        expect(runbook).toMatch(/색인[^\n]*(되지 않|미등록)/);
        expect(runbook).toMatch(/canonical[^\n]*(불일치|mismatch)/i);
        expect(runbook).toMatch(
            /(sitemap|사이트맵)[\s\S]{0,200}(색인 생성 요청|indexing request)[\s\S]{0,300}(힌트|hint)/i,
        );
        for (const nonGuarantee of [
            /색인[^\n]*(보장하지|보장할 수 없)/,
            /1위[^\n]*(보장하지|보장할 수 없)/,
            /AI[^\n]*(인용|citation)[^\n]*(보장하지|보장할 수 없)/i,
            /ChatGPT[^\n]*(추천|recommendation)[^\n]*(보장하지|보장할 수 없)/i,
        ]) {
            expect(runbook).toMatch(nonGuarantee);
        }

        for (const officialOrigin of [
            'https://support.google.com/webmasters/',
            'https://developers.google.com/search/docs/',
            'https://developers.openai.com/api/docs/bots',
            'https://help.openai.com/en/articles/12627856-publishers-and-developers-faq',
        ]) {
            expect(runbook).toContain(officialOrigin);
        }
    });

    it('keeps troubleshooting guidance isolated and actionable', () => {
        const runbook = readRunbook();
        const troubleshooting = readSection(runbook, '## 8. 문제 해결');

        const unavailable = readSection(
            troubleshooting,
            '### Generative AI 보고서가 없을 때',
        );
        expect(unavailable).toMatch(/rollout|노출이 부족|노출 부족/i);
        expect(unavailable).toMatch(/포함[^\n]*확인|다시 확인|계속 관찰/);

        const notIndexed = readSection(troubleshooting, '### 색인되지 않을 때');
        expect(notIndexed).toMatch(/HTTP[^\n]*robots[^\n]*noindex/i);
        expect(notIndexed).toMatch(/실시간 테스트[^\n]*(색인 생성|요청)/);

        const canonicalMismatch = readSection(
            troubleshooting,
            '### canonical 불일치(canonical mismatch)',
        );
        expect(canonicalMismatch).toMatch(/Google-selected canonical/i);
        expect(canonicalMismatch).toMatch(/User-declared canonical/i);
        expect(canonicalMismatch).toMatch(/비교/);
        expect(canonicalMismatch).toMatch(/수정[^\n]*(실시간 테스트|재크롤링)/);
    });

    it('allows only operational and authoritative URLs', () => {
        const runbook = readRunbook();
        const allowedHosts = new Set([
            'yeosachin.com',
            'developers.google.com',
            'support.google.com',
            'search.google.com',
            'developers.openai.com',
            'help.openai.com',
        ]);
        const urls = [
            ...runbook.matchAll(/https?:\/\/[^\s<>()\[\]`"']+/g),
        ].map(match => match[0]);

        expect(urls.length).toBeGreaterThan(0);
        const disallowed = urls.filter((url) => {
            try {
                return !allowedHosts.has(new URL(url).hostname);
            } catch {
                return true;
            }
        });
        expect(disallowed).toEqual([]);
    });

    it('contains no value-shaped secrets, credentials, or user identifiers', () => {
        const runbook = readRunbook();

        expect(runbook).toMatch(
            /^(?=.*(?:인증|확인|verification)[^\n]*토큰)(?=.*(?:자격 증명|credentials))(?=.*쿠키)(?=.*(?:사용자 ID|사용자 식별자))(?=.*문서)(?=.*붙여\s*넣지)[^\n]+$/mi,
        );

        const forbiddenValues: Array<[RegExp, string]> = [
            [
                /google-site-verification\s*[:=]\s*(?!<|\[|\{|\$|YOUR_|REDACTED|PLACEHOLDER)[A-Za-z0-9_-]{8,}/i,
                `google-site-verification=${'a'.repeat(24)}`,
            ],
            [
                /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
                '11111111-1111-4111-8111-111111111111',
            ],
            [
                /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
                `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`,
            ],
            [
                /\b(?:sk-(?:proj|svcacct)-|sbp_|sb_(?:secret|publishable)_|AIza|re_)[A-Za-z0-9_-]{12,}\b/i,
                `sb_secret_${'a'.repeat(24)}`,
            ],
            [
                /\b(?:SUPABASE_(?:SERVICE_ROLE_KEY|ANON_KEY)|SERVICE_ROLE_KEY|API_KEY)\s*[:=]\s*(?!<|\[|\{|\$|YOUR_|REDACTED|PLACEHOLDER)[^\s`]{8,}/i,
                `SUPABASE_SERVICE_ROLE_KEY=${'a'.repeat(24)}`,
            ],
            [
                /\b(?:cookie|set-cookie)\s*[:=]\s*(?!<|\[|\{|\$|YOUR_|REDACTED|PLACEHOLDER)[^\s`]{4,}/i,
                'Cookie: session=fake-value',
            ],
            [
                /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
                'operator@example.test',
            ],
            [
                /(?:^|[^A-Za-z0-9_])(?:user[_ -]?id|username|사용자\s*(?:ID|식별자|이름))\s*[:=]\s*(?!<|\[|\{|\$|YOUR_|REDACTED|PLACEHOLDER)[^\s,;`]{3,}/im,
                '사용자 ID=private-user',
            ],
            [
                /(?:^|[^A-Za-z0-9_])(?:password|passwd|secret|token|credential|비밀번호|자격\s*증명)\s*[:=]\s*(?!<|\[|\{|\$|YOUR_|REDACTED|PLACEHOLDER)[^\s`]{4,}/im,
                '비밀번호=fake-password',
            ],
        ];
        for (const [forbidden, representativeValue] of forbiddenValues) {
            expect(representativeValue).toMatch(forbidden);
            expect(runbook).not.toMatch(forbidden);
        }
    });
});
