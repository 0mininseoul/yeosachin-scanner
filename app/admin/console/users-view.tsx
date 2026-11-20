'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { PAGE_SIZE, errorMessage, formatCount, formatDateTime, formatKrw, requestJson } from './console-data';
import { Chip, EmptyRow } from './console-ui';
import { TablePanel, TableTools } from './table-panel';
import { UserStatsPanel } from './user-stats-panel';

type UserRow = Record<string, string | number | boolean | null> & { id: string };

const usersSchema = z.object({
    rows: z.array(z.object({ id: z.string().uuid() }).catchall(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(50),
    nextCursor: z.string().nullable(),
});

/** Korean labels for known users columns; any new column still shows under its raw name. */
const FIELD_LABEL: Record<string, string> = {
    id: '유저 ID', email: '이메일', provider: '로그인 수단', name: '이름', nickname: '닉네임',
    phone_number: '전화번호', phone_number_normalized: '전화번호(정규화)',
    phone_number_verification_source: '전화번호 확인 출처', phone_number_verified_at: '전화번호 확인 시각',
    gender: '성별', birthyear: '출생연도', profile_image: '프로필 사진',
    analysis_count: '분석 횟수', is_paid_user: '유료 사용자', is_unlimited: '무제한',
    account_class: '계정 분류', traffic_class: '트래픽 분류', lifecycle: '계정 상태',
    classification_version: '분류 버전', first_paid_at: '첫 결제 시각', signup_attribution_label: '가입 유입 경로',
    created_at: '가입 시각', updated_at: '수정 시각',
    paid_order_count: '결제 주문 수', paid_amount_krw: '누적 결제 금액', last_paid_at: '마지막 결제 시각',
    lead_input_count: '분석 입력 수',
};

const FIELD_ORDER = Object.keys(FIELD_LABEL);

function str(value: UserRow[string]): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function displayValue(key: string, value: UserRow[string]): string {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? '예' : '아니오';
    if (key === 'paid_amount_krw' && typeof value === 'number') return formatKrw(value);
    if (typeof value === 'number') return formatCount(value);
    if (/_at$/.test(key)) return formatDateTime(value);
    if (key === 'gender') return value === 'female' ? '여성' : value === 'male' ? '남성' : value;
    return value;
}

function lifecycleTone(value: UserRow[string]): 'ok' | 'warn' | 'block' | 'none' {
    if (value === 'active') return 'ok';
    if (typeof value === 'string' && /(retired|deleted|blocked|suspend)/.test(value)) return 'block';
    return 'none';
}

export type UsersTab = 'stats' | 'table';

export function UsersView({ tab }: { tab: UsersTab }) {
    return tab === 'stats' ? <UserStatsPanel /> : <UsersTable />;
}

function UsersTable() {
    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [rows, setRows] = useState<UserRow[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    const sequence = useRef(0);

    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
        return () => window.clearTimeout(timer);
    }, [search]);

    const load = useCallback(async (cursor: string | null) => {
        const current = sequence.current + 1;
        sequence.current = current;
        setLoading(true);
        setError(null);
        const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
        if (debounced) params.set('search', debounced.slice(0, 100));
        if (cursor) params.set('cursor', cursor);
        try {
            const body = await requestJson(`/api/admin/users?${params.toString()}`, usersSchema);
            if (sequence.current !== current) return;
            setRows(previous => (cursor ? [...previous, ...body.rows as UserRow[]] : body.rows as UserRow[]));
            setNextCursor(body.nextCursor);
        } catch (caught) {
            if (sequence.current !== current) return;
            if (!cursor) { setRows([]); setNextCursor(null); }
            setError(errorMessage(caught, '유저 목록을 불러오지 못했습니다.'));
        } finally {
            if (sequence.current === current) setLoading(false);
        }
    }, [debounced]);

    useEffect(() => { void load(null); }, [load]);

    return <TablePanel
        tools={<TableTools
            summary={<><b>유저 DB</b><span className="ac-muted">가입 최신순 · 행을 펼치면 모든 컬럼</span></>}
            search={{ value: search, onChange: setSearch, label: '유저 검색', placeholder: '이름 · 닉네임 · 이메일 · 전화번호' }}
        />}
        error={error}
        onRetry={() => void load(null)}
        loading={loading}
        loadedLabel={`${rows.length}명 불러옴`}
        hasNext={nextCursor !== null}
        onLoadMore={() => { if (nextCursor) void load(nextCursor); }}
    >
        <table className="ac-table">
            <caption className="ac-sr">유저 목록</caption>
            <thead><tr>
                <th scope="col">가입 시각</th><th scope="col">이름</th><th scope="col">연락처</th>
                <th scope="col">성별 · 출생</th><th scope="col">유입 경로</th>
                <th scope="col" className="ac-num">결제</th><th scope="col" className="ac-num">분석 입력</th>
                <th scope="col">계정 상태</th><th scope="col"><span className="ac-sr">전체 보기</span></th>
            </tr></thead>
            <tbody>
                {rows.length === 0 && !loading ? <EmptyRow colSpan={9}>{error ? '유저 목록을 확인할 수 없습니다.' : '조건에 맞는 유저가 없습니다.'}</EmptyRow> : null}
                {rows.map(row => {
                    const expanded = open === row.id;
                    const panelId = `user-${row.id}`;
                    const extraKeys = Object.keys(row).filter(key => !FIELD_ORDER.includes(key)).sort();
                    return <Fragment key={row.id}>
                        <tr>
                            <td className="ac-muted">{displayValue('created_at', row.created_at ?? null)}</td>
                            <td><b className="ac-strong">{str(row.name) ?? '이름 없음'}</b><span className="ac-sub">{str(row.nickname) ?? str(row.provider) ?? ''}</span></td>
                            <td><span>{str(row.email) ?? '—'}</span><span className="ac-sub">{str(row.phone_number) ?? '전화번호 없음'}</span></td>
                            <td>{[displayValue('gender', row.gender ?? null), str(row.birthyear)].filter(value => value && value !== '—').join(' · ') || '—'}</td>
                            <td>{str(row.signup_attribution_label) ?? <span className="ac-muted">미상</span>}</td>
                            <td className="ac-num"><b className="ac-strong">{formatCount(Number(row.paid_order_count ?? 0))}건</b><span className="ac-sub">{formatKrw(Number(row.paid_amount_krw ?? 0))}</span></td>
                            <td className="ac-num">{formatCount(Number(row.lead_input_count ?? 0))}</td>
                            <td><Chip tone={lifecycleTone(row.lifecycle ?? null)}>{str(row.lifecycle) ?? '미상'}</Chip><span className="ac-sub">{[str(row.account_class), str(row.traffic_class)].filter(Boolean).join(' · ')}</span></td>
                            <td><button type="button" className="ac-btn ac-btn--sm" aria-expanded={expanded} aria-controls={panelId} onClick={() => setOpen(expanded ? null : row.id)}>{expanded ? '접기' : '전체 보기'}</button></td>
                        </tr>
                        {expanded ? <tr id={panelId}><td colSpan={9} className="ac-ledger-cell">
                            <dl className="ac-user-fields">
                                {[...FIELD_ORDER.filter(key => key in row), ...extraKeys].map(key => <div key={key}>
                                    <dt>{FIELD_LABEL[key] ?? key}<small>{key}</small></dt>
                                    <dd>{key === 'profile_image' && str(row[key])
                                        ? <a href={str(row[key])!} target="_blank" rel="noreferrer noopener">사진 열기</a>
                                        : displayValue(key, row[key] ?? null)}</dd>
                                </div>)}
                            </dl>
                        </td></tr> : null}
                    </Fragment>;
                })}
            </tbody>
        </table>
    </TablePanel>;
}
