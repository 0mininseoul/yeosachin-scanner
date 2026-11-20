'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    MAPPING_LABEL,
    PAGE_SIZE,
    errorMessage,
    formatCount,
    formatDateTime,
    leadInputsSchema,
    requestJson,
    type LeadInputRow,
    type Tone,
} from './console-data';
import { Chip, EmptyRow } from './console-ui';
import { TablePanel, TableTools, type ActiveFilter } from './table-panel';

type MappingFilter = '' | LeadInputRow['mappingStatus'];
type StatusFilter = '' | 'completed' | 'failed' | 'processing' | 'not_requested' | 'unknown';

const STATUS_FILTER_LABEL: Record<Exclude<StatusFilter, ''>, string> = {
    completed: '완료',
    failed: '실패',
    processing: '진행 중',
    not_requested: '미요청',
    unknown: '기록 없음',
};

const FAILURE_LABEL: Record<string, string> = {
    TARGET_PRIVATE: '비공개 계정',
    TARGET_NOT_FOUND: '존재하지 않는 계정',
    TARGET_UNSUPPORTED: '분석할 수 없는 계정',
    HANDLE_FORMAT_INVALID: '아이디 형식 오류',
    PLAN_CAPACITY_EXCEEDED: '요금제 수용 한도 초과',
    EXCLUSION_RULE_VIOLATION: '제외 계정 규칙 위반',
    PROVIDER_TEMPORARY_FAILURE: '수집 업체 일시 오류',
    RATE_LIMITED: '요청 한도 초과',
    UNAUTHORIZED: '인증 필요',
    INTERNAL_ERROR: '내부 오류',
    PREFLIGHT_EXPIRED: '완료 전 만료',
    ANALYSIS_FAILED: '사전 점검 실패',
};

const STAGE_LABEL: Record<string, string> = {
    request: '요청 단계',
    profile: '프로필 조회',
    exclusion: '제외 계정 확인',
    preflight: '사전 점검',
};

export function preflightStatusOf(row: LeadInputRow): { tone: Tone; label: string } {
    if (row.preflightStatus === 'completed') return { tone: 'ok', label: '완료' };
    if (row.preflightStatus === 'failed') return { tone: 'block', label: '실패' };
    if (row.preflightStatus === 'processing') return { tone: 'warn', label: '진행 중' };
    if (row.preflightId) return { tone: 'none', label: '기록 없음' };
    return { tone: 'none', label: '미요청' };
}

function dayBoundary(value: string, endOfDay: boolean): string | null {
    if (!value) return null;
    const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+09:00`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ResultCell({ row }: { row: LeadInputRow }) {
    if (row.preflightStatus === 'failed') {
        const code = row.preflightErrorCode ?? 'ANALYSIS_FAILED';
        return <>
            <b className="ac-strong">{FAILURE_LABEL[code] ?? code}</b>
            <span className="ac-sub">{[row.preflightStage ? STAGE_LABEL[row.preflightStage] ?? row.preflightStage : null, code].filter(Boolean).join(' · ')}</span>
        </>;
    }
    if (row.preflightStatus === 'completed') {
        const facts = [
            row.preflightFollowersCount !== null ? `팔로워 ${formatCount(row.preflightFollowersCount)}` : null,
            row.preflightFollowingCount !== null ? `팔로잉 ${formatCount(row.preflightFollowingCount)}` : null,
            row.preflightRequiredPlanId ? `필요 요금제 ${row.preflightRequiredPlanId}` : null,
        ].filter(Boolean).join(' · ');
        return <>
            {row.preflightScreenAvailable && row.preflightId
                ? <a className="ac-btn ac-btn--sm" href={`/admin0min/preflight/${row.preflightId}`} target="_blank" rel="noreferrer">유저가 본 화면 열기 ↗</a>
                : <span className="ac-muted">화면 정리됨 (보관 기간 경과)</span>}
            <span className="ac-sub">{facts || '수치 기록 없음'}</span>
        </>;
    }
    if (row.preflightStatus === 'processing') return <span className="ac-muted">사전 점검 진행 중</span>;
    if (row.preflightId) return <span className="ac-muted">preflight 기록이 정리돼 결과를 알 수 없습니다</span>;
    return <span className="ac-muted">분석 요청 전 이탈</span>;
}

export function PreflightView() {
    const [mapping, setMapping] = useState<MappingFilter>('');
    const [status, setStatus] = useState<StatusFilter>('');
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
        if (status) params.set('preflightStatus', status);
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
            setError(errorMessage(caught, 'Preflight 목록을 불러오지 못했습니다.'));
        } finally {
            if (sequence.current === current) setLoading(false);
        }
    }, [debouncedId, from, mapping, status, to]);

    useEffect(() => { void load(null); }, [load]);

    const activeFilters: ActiveFilter[] = [
        ...(status ? [{ key: 'status', label: STATUS_FILTER_LABEL[status], onClear: () => setStatus('') }] : []),
        ...(mapping ? [{ key: 'mapping', label: MAPPING_LABEL[mapping], onClear: () => setMapping('') }] : []),
        ...(from || to ? [{ key: 'date', label: `${from || '처음'} ~ ${to || '오늘'}`, onClear: () => { setFrom(''); setTo(''); } }] : []),
    ];

    return <TablePanel
        tools={<TableTools
            summary={<><b>Preflight 입력</b><span className="ac-muted">입력 1회 = 1행 · 입력 최신순</span></>}
            search={{ value: instagramId, onChange: setInstagramId, label: '인스타 아이디 검색', placeholder: '대상 또는 제외 계정 아이디' }}
            activeFilters={activeFilters}
            filters={<>
                <label className="ac-field">Preflight 상태
                    <select value={status} onChange={event => setStatus(event.target.value as StatusFilter)}>
                        <option value="">전체</option>
                        {(Object.keys(STATUS_FILTER_LABEL) as Exclude<StatusFilter, ''>[]).map(value => <option key={value} value={value}>{STATUS_FILTER_LABEL[value]}</option>)}
                    </select>
                </label>
                <label className="ac-field">유저 구분
                    <select value={mapping} onChange={event => setMapping(event.target.value as MappingFilter)}>
                        <option value="">전체</option>
                        {Object.entries(MAPPING_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                </label>
                <label className="ac-field">시작일<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
                <label className="ac-field">종료일<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
                <span className="ac-meta">기록 없음 = 상태 기록이 시작되기 전에 preflight가 정리된 입력</span>
            </>}
        />}
        error={error}
        onRetry={() => void load(null)}
        loading={loading}
        loadedLabel={`${rows.length}건 불러옴`}
        hasNext={nextCursor !== null}
        onLoadMore={() => { if (nextCursor) void load(nextCursor); }}
    >
        <table className="ac-table">
            <caption className="ac-sr">Preflight 입력 기록</caption>
            <thead><tr><th scope="col">입력 일시</th><th scope="col">유저</th><th scope="col">유입 경로</th><th scope="col">분석 대상 · 제외 계정</th><th scope="col">Preflight 상태</th><th scope="col">결과 · 실패 사유</th></tr></thead>
            <tbody>
                {rows.length === 0 && !loading ? <EmptyRow colSpan={6}>{error ? 'Preflight 목록을 확인할 수 없습니다.' : '조건에 맞는 입력이 없습니다.'}</EmptyRow> : null}
                {rows.map(row => {
                    const state = preflightStatusOf(row);
                    return <tr key={`${row.inputAt}:${row.targetInstagramId}`} className={state.tone === 'block' ? 'is-block' : undefined}>
                        <td className="ac-muted">{formatDateTime(row.inputAt)}</td>
                        <td><b className="ac-strong">{row.userName ?? (row.mappingStatus === 'authenticated_user' ? '이름 미상' : row.mappingStatus === 'anonymous_device' ? '비로그인' : row.mappingStatus === 'unlinked_after_deletion' ? '탈퇴한 사용자' : '미연결')}</b><span className="ac-sub">{MAPPING_LABEL[row.mappingStatus]}</span></td>
                        <td>{row.attributionLabel ?? <span className="ac-muted">미상</span>}</td>
                        <td><b className="ac-strong">@{row.targetInstagramId}</b><span className="ac-sub">{row.excludedInstagramId ? `제외 @${row.excludedInstagramId}` : '제외 계정 입력 안 함'}</span></td>
                        <td><Chip tone={state.tone}>{state.label}</Chip>{row.preflightOutcomeAt ? <span className="ac-sub">{formatDateTime(row.preflightOutcomeAt)}</span> : null}</td>
                        <td><ResultCell row={row} /></td>
                    </tr>;
                })}
            </tbody>
        </table>
    </TablePanel>;
}
