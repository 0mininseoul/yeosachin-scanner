import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SuspectRow, type SuspectRowAccount } from './suspect-row';

describe('SuspectRow shared-view overview masking', () => {
    const account: SuspectRowAccount = {
        instagramId: 'chan__0.o',
        fullName: '김채은',
        riskGrade: 'normal',
        riskAnalysis: [],
        oneLineOverview: '채은님은 일본 여행의 추억을 공유하며 9ad8fa.01의 게시물에 좋아요를 눌렀습니다.',
    };

    it('masks the target handle inside the overview when maskHandle is set (share view)', () => {
        const markup = renderToStaticMarkup(
            <SuspectRow
                account={account}
                rank={1}
                avatar={<span />}
                externalProfileLinks={false}
                maskHandle
                targetInstagramId="9ad8fa.01"
            />
        );

        // The identifier is wrapped in the same blur-mask span used for the
        // handle/name elsewhere on the row, not left as plain legible text.
        expect(markup).toContain('>9ad8fa.01</span>');
        expect(markup).toMatch(/style="filter:blur\(5px\)"[^>]*>9ad8fa\.01<\/span>/);
        // Surrounding text stays legible and unwrapped.
        expect(markup).toContain('채은님은 일본 여행의 추억을 공유하며 ');
        expect(markup).toContain('의 게시물에 좋아요를 눌렀습니다.');
    });

    it('masks the row own handle inside the overview when it appears literally', () => {
        const ownHandleAccount: SuspectRowAccount = {
            ...account,
            instagramId: '2ynbiu',
            oneLineOverview: '2ynbiu는 9ad8fa.01의 게시물에 좋아요를 눌러 관심을 표현했습니다.',
        };
        const markup = renderToStaticMarkup(
            <SuspectRow
                account={ownHandleAccount}
                rank={3}
                avatar={<span />}
                externalProfileLinks={false}
                maskHandle
                targetInstagramId="9ad8fa.01"
            />
        );

        expect(markup).toMatch(/style="filter:blur\(5px\)"[^>]*>2ynbiu<\/span>/);
        expect(markup).toMatch(/style="filter:blur\(5px\)"[^>]*>9ad8fa\.01<\/span>/);
    });

    it('renders the overview verbatim on the owner view (maskHandle=false)', () => {
        const markup = renderToStaticMarkup(
            <SuspectRow
                account={{ ...account, recentMutualRank: 2 }}
                rank={1}
                avatar={<span />}
                externalProfileLinks={false}
            />
        );

        expect(markup).toContain('채은님은 일본 여행의 추억을 공유하며 9ad8fa.01의 게시물에 좋아요를 눌렀습니다.');
        expect(markup).toContain('가장 최근 맞팔한 여자 2번째');
        expect(markup).not.toContain('filter:blur(5px)');
    });
});
