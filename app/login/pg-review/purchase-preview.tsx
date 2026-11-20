'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AnalysisPlanCards, AnalysisPlanSection } from '@/components/analysis-plan-selection';
import { CaseCard, PrimaryButton } from '@/components/case-ui';
import { ANALYSIS_PLAN_CATALOG, buildPlanSelectionCards, type PlanId } from '@/lib/domain/analysis/plan-catalog';
import { EARLYBIRD_DISCLOSURE_TEXT, isPaidEarlybirdPlanId } from '@/lib/domain/earlybird/catalog';
import { buildEarlybirdPlanPresentation } from '@/lib/services/earlybird/ui-state';

const plans = buildPlanSelectionCards({ followers: 100, following: 100 }).map(card => ({
    ...ANALYSIS_PLAN_CATALOG[card.planId],
    ...card,
}));

export function PurchasePreview() {
    const [plan, setPlan] = useState<PlanId>('basic');
    const [showOrder, setShowOrder] = useState(false);
    const presentation = buildEarlybirdPlanPresentation(plan);
    const paidPlan = isPaidEarlybirdPlanId(plan);

    return (
        <>
            <p className="mt-2 text-sm text-fg-dim">
                샘플 계정 기준의 심사용 화면입니다. 요금제, 결제 금액과 구매 안내를 확인할 수 있습니다.
            </p>
            <AnalysisPlanSection>
                <AnalysisPlanCards plans={plans} requiredPlan="basic" selectedPlan={plan}
                    onPlanSelection={nextPlan => {
                        if (!isPaidEarlybirdPlanId(nextPlan)) return;
                        setPlan(nextPlan);
                        setShowOrder(false);
                    }} />
                {paidPlan && (
                    <>
                        <p className="mt-4 text-xs leading-relaxed text-fg-dim">{EARLYBIRD_DISCLOSURE_TEXT}</p>
                        <PrimaryButton type="button" className="mt-5" onClick={() => setShowOrder(true)}>
                            구매 내용 확인
                        </PrimaryButton>
                    </>
                )}
                {showOrder && paidPlan && (
                    <CaseCard className="mt-5 p-5" role="status">
                        <h3 className="font-bold text-fg">주문 내용</h3>
                        <dl className="mt-3 space-y-2 text-sm text-fg">
                            <div className="flex justify-between">
                                <dt>상품</dt>
                                <dd>AI 판독 리포트 · {plan === 'basic' ? 'Basic' : 'Standard'}</dd>
                            </div>
                            <div className="flex justify-between">
                                <dt>결제 예정 금액</dt>
                                <dd className="font-bold">{presentation.priceLabel}</dd>
                            </div>
                        </dl>
                        <p className="mt-3 text-xs text-fg-dim">심사 단계에서는 실제 결제가 진행되지 않습니다.</p>
                    </CaseCard>
                )}
            </AnalysisPlanSection>
            <div className="mt-6 flex gap-4 text-xs text-fg-dim">
                <Link className="underline" href="/terms">이용약관 및 환불 안내</Link>
                <Link className="underline" href="/privacy">개인정보처리방침</Link>
            </div>
        </>
    );
}
