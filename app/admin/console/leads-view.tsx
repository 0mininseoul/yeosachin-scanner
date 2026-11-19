'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    MAPPING_LABEL,
    PAGE_SIZE,
    errorMessage,
    formatDateTime,
    leadInputsSchema,
    requestJson,
    type LeadInputRow,
} from './console-data';
import { Card, EmptyRow, ErrorNotice } from './console-ui';

type MappingFilter = '' | LeadInputRow['mappingStatus'];

function dayBoundary(value: string, endOfDay: boolean): string | null {
    if (!value) return null;
    // Date inputs are KST calendar days.
    const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+09:00`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function LeadsView() {
    const [mapping, setMapping] = useState<MappingFilter>('');
    const [instagramId, setInstagramId] = useState('');
    const [debouncedId, setDebouncedId] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [rows, setRows] = useState<LeadInputRow[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const sequence = useRef(0);

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedId(instagramId.trim().replace(/^@+/, '').toLowerCase()), 300);
        return () => window.clearTimeout(timer);
    }, [instagramId]);

    const load = useCallback(async (cursor: string | null) => {
        const current = sequence.current + 1;
        sequence.current = current;
        setLoading(true);
        setError(null);
        if (!cursor) { setRows([]); setNextCursor(null); }
        const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
        if (mapping) params.set('mappingStatus', mapping);
        if (debouncedId) params.set('instagramId', debouncedId);
        const fromIso = dayBoundary(from, false);
        const toIso = dayBoundary(to, true);
        if (fromIso) params.set('from', fromIso);
        if (toIso) params.set('to', toIso);
        if (cursor) params.set('cursor', cursor);
        try {
            const body = await requestJson(`/api/admin/lead-inputs?${params.toString()}`, leadInputsSchema);
            if (sequence.current !== current) return;
            setRows(previous => (cursor ? [...previous, ...body.rows] : body.rows));
            setNextCursor(body.nextCursor);
        } catch (caught) {
            if (sequence.current !== current) return;
            setError(errorMessage(caught, '리드 목록을 불러오지 못했습니다.'));
        } finally {
            if (sequence.current === current) setLoading(false);
        }
    }, [debouncedId, from, mapping, to]);

    useEffect(() => { void load(null); }, [load]);

    return <Card>
        <div className="ac-toolbar">
            <label className="ac-field">유저 구분
                <select value={mapping} onChange={event => setMapping(event.target.value as MappingFilter)}>
                    <option value="">전체</option>
                    {Object.entries(MAPPING_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
            </label>
            <label className="ac-field">인스타 아이디
                <input type="search" value={instagramId} placeholder="대상 또는 제외 계정" onChange={event => setInstagramId(event.target.value)} />
            </label>
            <label className="ac-field">시작일<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
            <label className="ac-field">종료일<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
            <span className="ac-spacer" />
            <span className="ac-meta">입력 1회 = 1행 · 제외 계정을 함께 입력했으면 같은 행에 표시</span>
        </div>
        <ErrorNotice message={error} onRetry={() => void load(null)} />
        <div className="ac-table-box"><table className="ac-table">
            <caption className="ac-sr">분석 계정 입력 기록</caption>
            <thead><tr><th scope="col">입력 일시</th><th scope="col">유저</th><th scope="col">유입 경로</th><th scope="col">분석 대상 계정</th><th scope="col">제외 계정</th></tr></thead>
            <tbody>
                {rows.length === 0 && !loading ? <EmptyRow colSpan={5}>{error ? '리드 목록을 확인할 수 없습니다.' : '조건에 맞는 입력이 없습니다.'}</EmptyRow> : null}
                {rows.map(row => <tr key={`${row.inputAt}:${row.targetInstagramId}`}>
                    <td className="ac-muted">{formatDateTime(row.inputAt)}</td>
                    <td><b className="ac-strong">{row.userName ?? (row.mappingStatus === 'authenticated_user' ? '이름 미상' : row.mappingStatus === 'anonymous_device' ? '비로그인' : row.mappingStatus === 'unlinked_after_deletion' ? '탈퇴한 사용자' : '미연결')}</b><span className="ac-sub">{MAPPING_LABEL[row.mappingStatus]}</span></td>
                    <td>{row.attributionLabel ?? <span className="ac-muted">미상</span>}</td>
                    <td className="ac-strong">@{row.targetInstagramId}</td>
                    <td>{row.excludedInstagramId ? <b className="ac-strong">@{row.excludedInstagramId}</b> : <span className="ac-muted">입력 안 함</span>}</td>
                </tr>)}
            </tbody>
        </table></div>
        <div className="ac-pager" aria-live="polite">
            <span>{loading ? '입력 기록을 불러오는 중…' : `${rows.length}건을 불러왔습니다${nextCursor ? ' · 다음 페이지 있음' : ''}`}</span>
            <button type="button" className="ac-btn ac-btn--sm" disabled={loading || !nextCursor} onClick={() => void load(nextCursor)}>{loading ? '불러오는 중…' : '다음 25건'}</button>
        </div>
    </Card>;
}
