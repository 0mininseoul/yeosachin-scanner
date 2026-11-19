'use client';

import type { ApifyAccountCreditInventoryRow } from '@/lib/contracts/apify-account-credit-inventory';
import { APIFY_FREE_CREDENTIAL_SLOTS, type ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import { accountTone, formatDateTime, formatUsd, remainingRatio } from './console-data';
import { Card, Chip, ErrorNotice, Loading, Meter } from './console-ui';

function freshUsd(row: ApifyAccountCreditInventoryRow | undefined, value: number | null): string {
    return row && row.freshnessState === 'fresh' ? formatUsd(value) : '미상';
}

function freshTime(row: ApifyAccountCreditInventoryRow | undefined, value: string | null): string {
    return row && row.freshnessState === 'fresh' ? formatDateTime(value) : '미상';
}

function freshness(row: ApifyAccountCreditInventoryRow | undefined): string {
    if (!row || row.freshnessState === 'missing') return '신선도 미상';
    return row.freshnessState === 'fresh' ? '최신' : '오래됨';
}

function health(row: ApifyAccountCreditInventoryRow | undefined): string {
    if (!row || row.healthState === 'missing') return '건강 미상';
    return row.healthState === 'healthy' ? '정상 조회' : '조회 실패';
}

export function AccountsView({ inventory, loadError, actionError, busySlot, paidBusy, onRetry, onToggle, onRefreshPaid }: {
    inventory: readonly ApifyAccountCreditInventoryRow[] | null;
    loadError: string | null;
    actionError: string | null;
    busySlot: ApifyCredentialSlot | null;
    paidBusy: boolean;
    onRetry: () => void;
    onToggle: (row: ApifyAccountCreditInventoryRow) => void;
    onRefreshPaid: () => void;
}) {
    const paid = inventory?.find(row => row.credentialSlot === 'secondary');
    const paidTone = accountTone(paid);
    const free = APIFY_FREE_CREDENTIAL_SLOTS.map(slot => ({ slot, row: inventory?.find(row => row.credentialSlot === slot) }));
    const tones = free.map(item => accountTone(item.row).tone);

    return <div className="ac-stack">
        <ErrorNotice message={loadError} onRetry={onRetry} />
        <ErrorNotice message={actionError} />
        <Card title="유료 계정" description="실제 과금이 발생하는 유일한 Apify 슬롯" actions={inventory ? <Chip tone={paidTone.tone}>{paidTone.label}</Chip> : null}>
            {!inventory ? <Loading label={loadError ? '계정 상태를 확인할 수 없습니다.' : '계정 상태를 불러오는 중…'} /> : <div className="ac-paid">
                <div className="ac-stack ac-stack--tight">
                    <div className="ac-row"><span className="ac-slot">secondary</span><span className="ac-role">유료 · 배차 우선순위 1</span></div>
                    <div className="ac-paid-amt">{freshUsd(paid, paid?.effectiveRemainingUsd ?? null)}<small>남음 / 한도 {freshUsd(paid, paid?.monthlyLimitUsd ?? null)}</small></div>
                    <Meter ratio={remainingRatio(paid)} />
                    <div className="ac-facts-line">
                        <span>이번 주기 사용 <b>{freshUsd(paid, paid?.monthlyUsageUsd ?? null)}</b></span>
                        <span>초기화 <b>{freshTime(paid, paid?.cycleResetAt ?? null)}</b></span>
                        <span>관측 <b>{freshTime(paid, paid?.observedAt ?? null)}</b></span>
                        <span>{freshness(paid)} · {health(paid)}</span>
                    </div>
                </div>
                <div className="ac-paid-side">
                    <button type="button" className="ac-btn ac-btn--primary" disabled={paidBusy} onClick={onRefreshPaid}>{paidBusy ? '조회 중…' : '지금 잔액 새로고침'}</button>
                    <p className="ac-meta">secondary만 유료 Apify 조회를 실행합니다. 무료 계정은 주기 스냅샷으로 갱신됩니다.</p>
                </div>
            </div>}
        </Card>

        <Card
            title="무료 계정 9개"
            description="secondary를 제외한 슬롯 · 배차 제외 / 복귀를 여기서 바로 전환"
            actions={inventory ? <span className="ac-meta">배차 가능 {tones.filter(t => t === 'ok').length} · 주의 {tones.filter(t => t === 'warn').length} · 차단 {tones.filter(t => t === 'block').length} · 제외 {tones.filter(t => t === 'none').length}</span> : null}
        >
            {!inventory ? <Loading label={loadError ? '계정 상태를 확인할 수 없습니다.' : '계정 상태를 불러오는 중…'} /> : <div className="ac-acc-grid">
                {free.map(({ slot, row }) => {
                    const tone = accountTone(row);
                    const excluded = Boolean(row?.manuallyExcluded);
                    return <article key={slot} className={`ac-acc${excluded ? ' is-off' : ''}`}>
                        <div className="ac-row ac-row--between"><span className="ac-slot">{slot}</span><Chip tone={tone.tone}>{tone.label}</Chip></div>
                        <div className="ac-acc-amt">{freshUsd(row, row?.effectiveRemainingUsd ?? null)}<small>/ {freshUsd(row, row?.monthlyLimitUsd ?? null)}</small></div>
                        <Meter ratio={remainingRatio(row)} tone={tone.tone} />
                        <div className="ac-facts-line">
                            <span>사용 <b>{freshUsd(row, row?.monthlyUsageUsd ?? null)}</b></span>
                            <span>초기화 <b>{freshTime(row, row?.cycleResetAt ?? null)}</b></span>
                            <span>{freshness(row)} · {health(row)}</span>
                        </div>
                        <p className="ac-acc-reason">{tone.reason}</p>
                        <div className="ac-row ac-row--between ac-acc-f">
                            <span className="ac-meta">{excluded ? '배차 대상 아님' : tone.tone === 'ok' ? '배차 대상' : '자동 배차 보류'}</span>
                            {row ? <button type="button" className={`ac-btn ac-btn--sm${excluded ? '' : ' ac-btn--danger'}`} disabled={busySlot === row.credentialSlot} aria-label={`${slot} ${excluded ? '배차 복귀' : '배차 제외'}`} onClick={() => onToggle(row)}>
                                {busySlot === row.credentialSlot ? '저장 중…' : excluded ? '배차 복귀' : '배차 제외'}
                            </button> : null}
                        </div>
                    </article>;
                })}
            </div>}
        </Card>
    </div>;
}
