'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { NAMCHIN_ADMIN_CONSOLE_PATH } from '@/lib/contracts/admin-console';
import { ConsoleWorkspaceSwitch } from './console-workspace-switch';
import { Card, EmptyRow, ErrorNotice } from './console-ui';

type Filter = { query: string; page: number };
type Roster = {
    rows: { email: string; phone: string; consentedAt: string; variant: 'bf' | 'crush' | null }[];
    count: number;
    hasNext: boolean;
    variantCounts: { bf: number; crush: number; none: number } | null;
};
const VARIANT_LABEL = { bf: 'A 남친', crush: 'B 짝남' } as const;
const DATE_TIME = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short', hour12: false,
});

function formatPhone(phone: string): string {
    return phone.replace(/^\+8210(\d{4})(\d{4})$/, '010-$1-$2');
}

export function NamchinWaitlistConsole() {
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<Filter>({ query: '', page: 1 });
    const [response, setResponse] = useState<{ filter: Filter; roster: Roster | null } | null>(null);
    const current = response?.filter === filter ? response : null;
    const roster = current?.roster;

    useEffect(() => {
        const controller = new AbortController();
        fetch('/api/admin/cherry/reservations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(filter),
            cache: 'no-store',
            signal: controller.signal,
        }).then(async response => {
            if (!response.ok) throw new Error('Reservations unavailable');
            return response.json() as Promise<Roster>;
        }).then(roster => {
            if (!controller.signal.aborted) setResponse({ filter, roster });
        }).catch(() => {
            if (!controller.signal.aborted) setResponse({ filter, roster: null });
        });
        return () => controller.abort();
    }, [filter]);

    const refresh = () => setFilter({ ...filter });

    return <div className="ac-app ac-namchin">
        <aside className="ac-side">
            <Link className="ac-brand" href={NAMCHIN_ADMIN_CONSOLE_PATH}>
                <Image src="/cherry/logo.png" className="ac-namchin-mark" alt="" width={34} height={34} unoptimized />
                <span><b>체리</b><small>운영 콘솔</small></span>
            </Link>
            <nav className="ac-nav" aria-label="콘솔 메뉴">
                <div className="ac-nav-label">운영</div>
                <Link className="ac-nav-btn" href={`${NAMCHIN_ADMIN_CONSOLE_PATH}&view=service`}>서비스 운영</Link>
                <Link className="ac-nav-btn is-active" href={NAMCHIN_ADMIN_CONSOLE_PATH} aria-current="page">사전 예약 명단</Link>
            </nav>
            <div className="ac-side-bottom"><ConsoleWorkspaceSwitch active="namchin" /></div>
        </aside>
        <main className="ac-main"><div className="ac-wrap">
            <header className="ac-top">
                <div>
                    <div className="ac-crumb"><span>운영 콘솔</span><span aria-hidden="true">/</span><span>체리(남친 맞팔 알리미)</span></div>
                    <h1>사전 예약 명단</h1>
                    <p>신청 이메일, 휴대폰 번호, 출시 알림 수신 동의 일시를 확인합니다.</p>
                </div>
                <button type="button" className="ac-btn" onClick={refresh}>새로고침</button>
            </header>
            <Card className="ac-namchin-roster">
                <div className="ac-tools-bar">
                    <span role="status">{roster ? `${filter.query ? '검색 결과' : '전체 신청'} ${roster.count}건` : ''}</span>
                    {roster?.variantCounts ? <span>메타 A/B 전체: A 남친 {roster.variantCounts.bf}건, B 짝남 {roster.variantCounts.crush}건, 변형 없음 {roster.variantCounts.none}건</span> : null}
                    <form className="ac-search" role="search" onSubmit={event => {
                        event.preventDefault();
                        setFilter({ query: search.trim(), page: 1 });
                    }}>
                        <label htmlFor="namchin-search" className="ac-sr">이메일 또는 휴대폰 번호 검색</label>
                        <input id="namchin-search" type="search" autoComplete="off" maxLength={254} value={search} placeholder="이메일 또는 휴대폰 번호" onChange={event => setSearch(event.target.value)} />
                        <button className="ac-btn" type="submit">검색</button>
                        {filter.query ? <button className="ac-link" type="button" onClick={() => {
                            setSearch('');
                            setFilter({ query: '', page: 1 });
                        }}>초기화</button> : null}
                    </form>
                </div>
                {current && !roster ? <ErrorNotice message="사전 예약 명단을 불러오지 못했습니다." onRetry={refresh} /> : null}
                <div className="ac-table-box">
                    <table className="ac-table" aria-label="사전 예약 명단">
                        <thead><tr>
                            <th scope="col">신청 이메일</th>
                            <th scope="col">휴대폰 번호</th>
                            <th scope="col">수신 동의 일시 <span className="ac-namchin-timezone">KST</span></th>
                            <th scope="col">광고 변형</th>
                        </tr></thead>
                        <tbody>{roster?.rows.length ? roster.rows.map(row => <tr key={row.email}>
                            <td><b>{row.email}</b></td>
                            <td className="ac-tabular">{formatPhone(row.phone)}</td>
                            <td><time dateTime={row.consentedAt}>{DATE_TIME.format(new Date(row.consentedAt))}</time></td>
                            <td>{row.variant ? VARIANT_LABEL[row.variant] : '변형 없음'}</td>
                        </tr>) : <EmptyRow colSpan={4}>{current ? (roster ? (filter.query ? '검색 조건에 맞는 예약이 없습니다.' : '아직 접수된 사전 예약이 없습니다.') : '명단을 표시할 수 없습니다.') : '불러오는 중…'}</EmptyRow>}</tbody>
                    </table>
                </div>
                {filter.page > 1 || roster?.hasNext ? <div className="ac-tools-bar" aria-label="명단 페이지">
                    <button className="ac-btn" type="button" disabled={filter.page === 1 || !current} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}>이전</button>
                    <span>{filter.page}페이지</span>
                    <button className="ac-btn" type="button" disabled={!roster?.hasNext} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}>다음</button>
                </div> : null}
            </Card>
        </div></main>
    </div>;
}
