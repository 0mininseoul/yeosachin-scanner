'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { errorMessage, formatCount, requestJson } from './console-data';
import { Card, ErrorNotice, Loading } from './console-ui';
import { TrendChart } from './trend-chart';

const statsSchema = z.object({
    total: z.number().int(),
    paidUsers: z.number().int(),
    byGenderAge: z.array(z.object({
        gender: z.enum(['female', 'male', 'unknown']),
        ageBand: z.enum(['10s', '20_24', '25_29', '30_34', '35_39', '40_plus', 'unknown']),
        users: z.number().int(),
        paidUsers: z.number().int(),
    })),
    bySource: z.array(z.object({ source: z.string(), users: z.number().int(), paidUsers: z.number().int() })),
    daily: z.array(z.object({ day: z.string(), signups: z.number().int() })),
});

type Stats = z.infer<typeof statsSchema>;

const AGE_BANDS: readonly { key: Stats['byGenderAge'][number]['ageBand']; label: string }[] = [
    { key: '10s', label: '10대' }, { key: '20_24', label: '20–24세' }, { key: '25_29', label: '25–29세' },
    { key: '30_34', label: '30–34세' }, { key: '35_39', label: '35–39세' }, { key: '40_plus', label: '40세 이상' },
    { key: 'unknown', label: '미상' },
];
const GENDERS = [
    { key: 'female', label: '여성', color: '#e0567a' },
    { key: 'male', label: '남성', color: '#2f5bea' },
    { key: 'unknown', label: '미상', color: '#9aa4b2' },
] as const;

function pct(part: number, whole: number): string {
    return whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—';
}

export function UserStatsPanel() {
    const [stats, setStats] = useState<Stats | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        requestJson('/api/admin/user-stats', statsSchema, { signal: controller.signal })
            .then(body => { if (!controller.signal.aborted) { setStats(body); setError(null); } })
            .catch(caught => { if (!controller.signal.aborted) setError(errorMessage(caught, '유저 통계를 불러오지 못했습니다.')); });
        return () => controller.abort();
    }, [reload]);

    if (!stats) return error ? <ErrorNotice message={error} onRetry={() => setReload(value => value + 1)} /> : <Loading label="유저 통계를 불러오는 중…" />;

    const genderTotals = GENDERS.map(gender => ({
        ...gender,
        users: stats.byGenderAge.filter(row => row.gender === gender.key).reduce((t, row) => t + row.users, 0),
    }));
    const bandRows = AGE_BANDS.map(band => {
        const cells = GENDERS.map(gender => stats.byGenderAge.find(row => row.ageBand === band.key && row.gender === gender.key));
        const users = cells.reduce((t, cell) => t + (cell?.users ?? 0), 0);
        const paid = cells.reduce((t, cell) => t + (cell?.paidUsers ?? 0), 0);
        return { ...band, cells, users, paid };
    }).filter(row => row.users > 0);
    const maxBand = Math.max(1, ...bandRows.map(row => row.users));
    const maxSource = Math.max(1, ...stats.bySource.map(row => row.users));
    const last = stats.daily.length - 1;
    const dayLabel = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
    const signupTotal = stats.daily.reduce((t, row) => t + row.signups, 0);

    return <div className="ac-stack">
        <div className="ac-kpis">
            <Card className="ac-kpi"><div className="ac-kpi-l">전체 가입자</div><div className="ac-kpi-v">{formatCount(stats.total)}<small>명</small></div><div className="ac-meta">최근 30일 +{formatCount(signupTotal)}명</div></Card>
            <Card className="ac-kpi"><div className="ac-kpi-l">결제 유저</div><div className="ac-kpi-v">{formatCount(stats.paidUsers)}<small>명</small></div><div className="ac-meta">가입자 대비 {pct(stats.paidUsers, stats.total)} · 0원·테스트 결제 제외</div></Card>
            {genderTotals.map(gender => <Card key={gender.key} className="ac-kpi"><div className="ac-kpi-l">{gender.label}</div><div className="ac-kpi-v">{formatCount(gender.users)}<small>명</small></div><div className="ac-meta">{pct(gender.users, stats.total)}</div></Card>)}
        </div>
        <div className="ac-cols ac-cols--even">
            <Card title="성별 · 연령대" description="카카오 동의항목 기준 · 올해 기준 나이(출생연도로 계산) · 막대 오른쪽은 결제 유저 수">
                <div className="ac-legend ac-pad">{GENDERS.map(gender => <span key={gender.key}><i style={{ background: gender.color }} />{gender.label}</span>)}</div>
                <ul className="ac-hbars">
                    {bandRows.map(row => <li key={row.key}>
                        <span className="ac-hbar-label">{row.label}</span>
                        <span className="ac-hbar-track" role="img" aria-label={`${row.label} ${GENDERS.map((gender, i) => `${gender.label} ${row.cells[i]?.users ?? 0}명`).join(', ')}`}>
                            {row.cells.map((cell, i) => cell && cell.users > 0
                                ? <span key={GENDERS[i]!.key} title={`${GENDERS[i]!.label} ${cell.users}명 · 결제 ${cell.paidUsers}명`} style={{ width: `${(cell.users / maxBand) * 100}%`, background: GENDERS[i]!.color }} />
                                : null)}
                        </span>
                        <span className="ac-hbar-value">{formatCount(row.users)}<small>결제 {formatCount(row.paid)}</small></span>
                    </li>)}
                </ul>
            </Card>
            <Card title="가입 유입 경로" description="가입 시점 첫 유입 라벨 · 막대 오른쪽은 결제 유저 수">
                <ul className="ac-hbars">
                    {stats.bySource.map(row => <li key={row.source}>
                        <span className="ac-hbar-label">{row.source === 'unknown' ? '미상' : row.source}</span>
                        <span className="ac-hbar-track" role="img" aria-label={`${row.source} ${row.users}명`}><span style={{ width: `${(row.users / maxSource) * 100}%`, background: '#2f5bea' }} /></span>
                        <span className="ac-hbar-value">{formatCount(row.users)}<small>결제 {formatCount(row.paidUsers)}</small></span>
                    </li>)}
                </ul>
            </Card>
        </div>
        <Card title="일별 가입자" description="최근 30일 · KST · 마지막 지점은 오늘">
            <div className="ac-charts ac-charts--single">
                <TrendChart
                    title="가입자"
                    total={`${formatCount(signupTotal)}명`}
                    totalNote="최근 30일 합계"
                    labels={stats.daily.map((row, i) => (i === last ? '오늘' : i % 5 === 0 && i < last - 2 ? dayLabel(row.day) : ''))}
                    tooltipLabels={stats.daily.map((row, i) => (i === last ? `${dayLabel(row.day)} · 오늘` : dayLabel(row.day)))}
                    series={[{ name: '가입자', color: '#2e9e5b', fill: 'rgba(46,158,91,0.2)', values: stats.daily.map(row => row.signups) }]}
                    format={value => `${formatCount(value)}명`}
                    note="users.created_at 기준 신규 가입 수"
                />
            </div>
        </Card>
    </div>;
}
