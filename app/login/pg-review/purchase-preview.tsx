'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AnalysisPlanCards, AnalysisPlanSection } from '@/components/analysis-plan-selection';
import { CaseCard } from '@/components/case-ui';
import { ANALYSIS_PLAN_CATALOG, buildPlanSelectionCards, type PlanId } from '@/lib/domain/analysis/plan-catalog';
import { EARLYBIRD_DISCLOSURE_TEXT, EARLYBIRD_PLAN_CATALOG, isPaidEarlybirdPlanId } from '@/lib/domain/earlybird/catalog';
import { buildEarlybirdPlanPresentation } from '@/lib/services/earlybird/ui-state';
import { TossReviewButton } from './toss-review-button';

const plans = buildPlanSelectionCards({ followers: 100, following: 100 }).map(card => ({
    ...ANALYSIS_PLAN_CATALOG[card.planId],
    ...card,
}));

export function PurchasePreview({ clientKey }: { clientKey: string | null }) {
    const [plan, setPlan] = useState<PlanId>('basic');
    const presentation = buildEarlybirdPlanPresentation(plan);
    const paidPlan = isPaidEarlybirdPlanId(plan);
    const orderName = `위장여사친 판독기 AI 판독 리포트 · ${plan === 'basic' ? 'Basic' : 'Standard'}`;

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
                    }} />
                <p className="mt-4 text-xs leading-relaxed text-fg-dim">{EARLYBIRD_DISCLOSURE_TEXT}</p>
                {paidPlan && (
                    <CaseCard className="mt-5 p-5">
                        <h3 className="font-bold text-fg">주문 내용</h3>
                        <dl className="mt-3 space-y-2 text-sm text-fg">
                            <div className="flex justify-between">
                                <dt>상품</dt>
                                <dd className="text-right">{orderName}</dd>
                            </div>
                            <div className="flex justify-between">
                                <dt>결제 예정 금액</dt>
                                <dd className="font-bold">{presentation.priceLabel}</dd>
                            </div>
                        </dl>
                        <TossReviewButton key={plan} product="analyzer" clientKey={clientKey}
                            amount={EARLYBIRD_PLAN_CATALOG[plan].earlybirdAmountKrw} orderName={orderName} />
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
