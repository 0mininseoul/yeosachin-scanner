'use client';

import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { RiskTag } from '@/components/case-ui';
import type { AnalysisAuditPayload } from '@/lib/services/analysis/score-audit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const labels: Record<string, string> = {
    candidateToTargetLikes: '상대 → 대상 좋아요',
    candidateToTargetComments: '상대 → 대상 댓글',
    candidateToTargetTagOrCaptionMention: '상대 → 대상 태그',
    targetToCandidateTagOrCaptionMention: '대상 → 상대 태그',
    targetToCandidateLike: '대상 → 상대 좋아요',
    recentMutual: '최근 맞팔',
    appearanceExposure: '공개 프로필 특성',
    weakPartnerAdjustment: '관계 안전 조정',
};

function Status({ value }: { value: AnalysisAuditPayload['request']['status'] }) {
    const tone = value === 'ready' ? 'text-jade border-jade/40' : value === 'inconsistent'
        ? 'text-blood border-blood/40' : 'text-amber border-amber/40';
    return <span className={`border px-2 py-1 text-[10px] font-bold tracking-[.15em] ${tone}`}>{value.toUpperCase()}</span>;
}

export function AnalysisAuditWorkbench({ initialRequestId }: { initialRequestId: string }) {
    const [requestId, setRequestId] = useState(initialRequestId);
    const [payload, setPayload] = useState<AnalysisAuditPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState<string | null>(null);
    const activeRequest = useRef<{
        sequence: number;
        controller: AbortController;
    } | null>(null);

    const canLoad = UUID.test(requestId);
    const endpoint = useMemo(() => canLoad
        ? `/api/admin/analysis-audit?requestId=${encodeURIComponent(requestId)}&pageSize=25`
        : null, [canLoad, requestId]);
    const displayedRows = useMemo(() => payload?.rows.filter(
        row => !row.officialGroupExcluded
    ) ?? [], [payload]);
    const officialRows = useMemo(() => payload?.rows.filter(
        row => row.officialGroupExcluded
    ) ?? [], [payload]);

    const load = useCallback(async (url = endpoint) => {
        if (!url) return;
        const sequence = (activeRequest.current?.sequence ?? 0) + 1;
        activeRequest.current?.controller.abort();
        const controller = new AbortController();
        activeRequest.current = { sequence, controller };
        setLoading(true); setError(null);
        try {
            const response = await fetch(url, {
                cache: 'no-store',
                credentials: 'same-origin',
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(response.status === 404 ? '완료된 감사 스냅샷을 찾지 못했습니다.' : '감사 데이터를 불러오지 못했습니다.');
            const nextPayload = await response.json() as AnalysisAuditPayload;
            if (activeRequest.current?.sequence !== sequence) return;
            setPayload(nextPayload);
            setExpanded(null);
        } catch (caught) {
            if (
                controller.signal.aborted
                || activeRequest.current?.sequence !== sequence
            ) return;
            setPayload(null);
            setError(caught instanceof Error ? caught.message : '감사 데이터를 불러오지 못했습니다.');
        } finally {
            if (activeRequest.current?.sequence === sequence) {
                activeRequest.current = null;
                setLoading(false);
            }
        }
    }, [endpoint]);

    return <div className="p-4 sm:p-6">
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void load(); }}>
            <label className="sr-only" htmlFor="analysis-audit-request">분석 요청 ID</label>
            <input id="analysis-audit-request" value={requestId} onChange={event => setRequestId(event.target.value)}
                placeholder="완료된 analysis request UUID" spellCheck={false}
                className="min-w-0 flex-1 border border-line bg-ink px-3 py-2.5 font-mono text-xs text-fg outline-none placeholder:text-fg-mute focus:border-blood" />
            <button type="submit" disabled={!canLoad || loading} className="inline-flex items-center gap-2 bg-blood px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">
                <Search className="h-3.5 w-3.5" aria-hidden="true" /> 조회
            </button>
        </form>
        {!canLoad && requestId.length > 0 ? <p className="mt-2 text-xs text-blood">UUID 형식의 requestId만 조회합니다.</p> : null}
        {error ? <p role="alert" className="mt-5 border-l-2 border-blood bg-blood/5 px-3 py-2 text-sm text-fg-dim">{error}</p> : null}
        {payload ? <>
            <section className="mt-6 grid gap-px bg-line sm:grid-cols-4" aria-label="감사 요약">
                <div className="bg-ink p-3"><span className="eyebrow">상태</span><div className="mt-2"><Status value={payload.request.status} /></div></div>
                <div className="bg-ink p-3"><span className="eyebrow">위험 정책</span><p className="mt-2 font-mono text-xs text-fg">{payload.request.riskPolicyVersion ?? '미확보'}</p></div>
                <div className="bg-ink p-3"><span className="eyebrow">AI 정책</span><p className="mt-2 font-mono text-xs text-fg">{payload.request.aiPolicyVersion ?? '미확보'}</p></div>
                <div className="bg-ink p-3"><span className="eyebrow">제외된 단체</span><p className="num mt-1 text-2xl font-extrabold text-fg">{payload.officialGroupCount}</p></div>
            </section>
            {payload.request.reason ? <p className="mt-3 text-xs text-amber">{payload.request.reason}</p> : null}
            <section className="mt-6" aria-live="polite">
                <div className="mb-2 flex items-baseline justify-between"><h2 className="eyebrow">공개 계정 / 최종 순위</h2><span className="text-xs text-fg-mute">저장된 스냅샷</span></div>
                <div className="overflow-x-auto border border-line">
                    <table className="min-w-[880px] w-full border-collapse text-left text-xs">
                        <thead className="bg-panel text-[10px] tracking-[.12em] text-fg-dim"><tr><th className="p-3">#</th><th className="p-3">계정</th><th className="p-3">분류</th><th className="p-3">점수</th><th className="p-3">밴드</th><th className="p-3">근거</th><th className="p-3" aria-label="상세" /></tr></thead>
                        <tbody>{displayedRows.map(row => <Fragment key={`${payload.request.requestId}:${payload.request.resultHash ?? 'pending'}:${row.candidateId}`}>
                            <tr className="border-t border-line hover:bg-panel/35">
                                <td className="num p-3 font-bold text-fg-dim">{row.rank}</td>
                                <td className="p-3"><p className="font-semibold text-fg">@{row.instagramId}</p></td>
                                <td className="p-3"><p className="text-fg">{row.accountContext}</p><p className="mt-0.5 text-fg-mute">{row.genderProvenance}</p></td>
                                <td className="num p-3 text-lg font-extrabold text-fg">{row.displayScore}</td>
                                <td className="p-3"><RiskTag grade={row.riskBand} /></td>
                                <td className="p-3 text-fg-dim">좋아요 {row.signals.candidateLikes} · 댓글 {row.signals.candidateComments} · 최근 {row.signals.recentMutualRank ?? '—'}</td>
                                <td className="p-3"><button type="button" onClick={() => setExpanded(expanded === row.candidateId ? null : row.candidateId)} className="inline-flex items-center gap-1 text-fg-dim hover:text-fg" aria-expanded={expanded === row.candidateId} aria-controls={`audit-${row.candidateId}`}>{expanded === row.candidateId ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}<span className="sr-only">상세 보기</span></button></td>
                            </tr>
                            {expanded === row.candidateId ? <tr id={`audit-${row.candidateId}`} className="border-t border-line bg-panel/30"><td colSpan={7} className="p-4"><div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
                                <div><p className="eyebrow">점수 원장 / 0.1점 단위</p><ul className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1 text-xs text-fg-dim">{row.components.map(component => <li key={component.key} className="flex justify-between border-b border-line/70 py-1"><span>{labels[component.key]}</span><strong className="num text-fg">{component.contributionUnits >= 0 ? '+' : ''}{component.contributionUnits}</strong></li>)}</ul><p className={`mt-3 text-xs ${row.scoreConsistent ? 'text-jade' : 'text-blood'}`}>{row.scoreConsistent ? `합계 검증됨 · 원점수 ${row.rawScoreUnits}` : `합계 불일치 · 원점수 ${row.rawScoreUnits} (조정하지 않음)`}</p></div>
                                <div><p className="eyebrow">정책 전이</p><p className="mt-2 text-xs leading-6 text-fg-dim">자연 점수 {row.naturalDisplayScore} → 최종 점수 {row.displayScore} · 상대위험도 보정 {row.relativeTierApplied ? '적용' : '미적용'} · 파트너 상한 {row.partnerCapApplied ? '적용' : '미적용'}</p><p className="mt-3 text-xs text-fg-dim">상대→대상 태그 {row.signals.candidateTagsTarget ? '있음' : '없음'} · 대상→상대 태그 {row.signals.targetTagsCandidate ? '있음' : '없음'} · 대상 좋아요 {row.signals.targetLikedCandidate}</p><p className="mt-2 text-xs text-fg-dim">외형 {row.signals.appearanceGrade}/5 · 노출 {row.signals.exposureScore}/5 · 약한 파트너 근거 {row.signals.hasWeakPartnerEvidence ? '있음' : '없음'} · 강한 근거 {row.signals.hasStrongPartnerEvidence ? '있음' : '없음'}</p></div>
                            </div></td></tr> : null}
                        </Fragment>)}</tbody>
                    </table>
                </div>
                {officialRows.length > 0 ? <div className="mt-6 border border-amber/30 bg-amber/5 p-4"><h3 className="eyebrow text-amber">개인 여성 위험 순위 제외 / 공식 단체·브랜드</h3><ul className="mt-3 grid gap-2 sm:grid-cols-2">{officialRows.map(row => <li key={`${payload.request.requestId}:${payload.request.resultHash ?? 'pending'}:official:${row.candidateId}`} className="flex items-center justify-between border border-line bg-ink px-3 py-2 text-xs"><span className="font-semibold text-fg">@{row.instagramId}</span><span className="text-amber">비순위 · {row.officialGroupReason}</span></li>)}</ul></div> : null}
                {payload.nextCursor !== null ? <button type="button" onClick={() => void load(`/api/admin/analysis-audit?requestId=${encodeURIComponent(payload.request.requestId)}&cursor=${payload.nextCursor}&pageSize=25`)} className="mt-3 border border-line px-3 py-2 text-xs font-bold text-fg-dim hover:border-blood hover:text-fg">다음 25명</button> : null}
            </section>
        </> : loading ? <p className="mt-6 text-sm text-fg-dim">감사 원장을 확인하는 중…</p> : null}
    </div>;
}
