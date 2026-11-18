import type { ReactNode } from 'react';
import { Eyebrow } from '@/components/case-ui';
import type { PlanQuoteV1 } from '@/lib/contracts/analysis-v2';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import { buildEarlybirdPlanPresentation, isEarlybirdPlanSelectable, isEarlybirdPlanSoldOut } from '@/lib/services/earlybird/ui-state';

const PLAN_NAMES: Readonly<Record<PlanId, string>> = {
    basic: 'Basic',
    standard: 'Standard',
    plus: 'Plus',
};

function relationshipCapacityLabel(
    capacity: { followers: number; following: number },
    lowerBound?: { followers: number; following: number } | null
): string {
    const fmt = (value: number) => value.toLocaleString('ko-KR');
    if (capacity.followers === capacity.following) {
        const upper = capacity.followers;
        if (lowerBound && lowerBound.followers === lowerBound.following && lowerBound.followers > 0) {
            return `팔로워·팔로잉 각 ${fmt(lowerBound.followers)}~${fmt(upper)}명`;
        }
        return `팔로워·팔로잉 각 ${fmt(upper)}명 이하`;
    }
    return `팔로워 ${fmt(capacity.followers)}명 · 팔로잉 ${fmt(capacity.following)}명 이하`;
}

export function AnalysisPlanSection({ children }: { children: ReactNode }) {
    return (
        <section
            id="plan-selection"
            className="mt-9 scroll-mt-20"
            aria-labelledby="plan-heading"
        >
            <Eyebrow>요금제 선택</Eyebrow>
            <h2
                id="plan-heading"
                className="mt-3 text-[22px] font-extrabold text-fg outline-none"
            >
                계정 규모에 맞는 플랜이에요
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
                전체 플랜을 비교해보고, 계정에 맞는 이용 가능한 플랜으로 진행하세요.
            </p>
            {children}
        </section>
    );
}

interface AnalysisPlanCardsProps {
    plans: readonly PlanQuoteV1[];
    requiredPlan: PlanId;
    selectedPlan: PlanId | null;
    onPlanSelection?: (planId: PlanId) => void;
    lockedPlan?: PlanId;
}

export function AnalysisPlanCards({ plans, requiredPlan, selectedPlan, onPlanSelection, lockedPlan }: AnalysisPlanCardsProps) {
    return (
        <fieldset className="mt-5 space-y-3">
            <legend className="sr-only">판독 플랜</legend>
            {plans.map((plan, index) => {
                const available = isEarlybirdPlanSelectable(
                    plan,
                    requiredPlan
                );
                const locked = lockedPlan !== undefined && plan.planId !== lockedPlan;
                const selected = selectedPlan === plan.planId;
                const presentation = buildEarlybirdPlanPresentation(plan.planId);
                const lowerBound = index > 0
                    ? plans[index - 1].relationshipCapacity
                    : null;
                return (
                    <label
                        key={plan.planId}
                        className={`block ${locked ? 'cursor-not-allowed' : 'cursor-pointer'} border p-3.5 transition-colors ${
                            selected
                                ? 'border-blood bg-blood/[0.08]'
                                : 'border-line-2 bg-ink-2 hover:border-fg-dim'
                        }`}
                    >
                        <input
                            type="radio"
                            name="analysis-plan"
                            value={plan.planId}
                            checked={selected}
                            disabled={locked}
                            onChange={() => onPlanSelection?.(plan.planId)}
                            className="sr-only"
                        />
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-[16px] font-extrabold text-fg">
                                        {PLAN_NAMES[plan.planId]}
                                    </span>
                                    {plan.selectionState === 'required' && (
                                        <span className="border border-blood/50 bg-blood/10 px-1.5 py-0.5 text-[10px] font-bold text-blood">
                                            이용 가능
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-[12px] text-fg-dim">
                                    {relationshipCapacityLabel(
                                        plan.relationshipCapacity,
                                        lowerBound
                                    )}
                                </p>
                            </div>
                            <span className={`mt-1 block h-[18px] w-[18px] shrink-0 rounded-full border ${
                                selected
                                    ? 'border-[5px] border-blood bg-white'
                                    : 'border-line-2'
                            }`} />
                        </div>

                        {presentation.referencePriceLabel ? (
                            <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span className="num text-[18px] text-fg-mute line-through">
                                    {presentation.referencePriceLabel}
                                </span>
                                <span className="text-[15px] text-fg-mute" aria-hidden>→</span>
                                <span className="num text-[22px] font-black leading-none tracking-tight text-fg">
                                    {presentation.priceLabel}
                                </span>
                                {presentation.discountLabel && (
                                    <span className="self-center border border-blood bg-blood/10 px-2 py-[3px] text-[13px] font-extrabold leading-none text-blood">
                                        {presentation.discountLabel}
                                    </span>
                                )}
                            </div>
                        ) : (
                            <p className="num mt-2.5 text-[15px] font-bold text-fg-dim">
                                {presentation.priceLabel}
                            </p>
                        )}

                        {plan.selectionState !== 'unavailable' && isEarlybirdPlanSoldOut(plan) ? (
                            <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] font-bold text-fg-mute">
                                얼리버드 물량이 모두 소진되었어요.
                            </p>
                        ) : available && typeof plan.remainingSlots === 'number' ? (
                            <p className="mt-2.5 flex items-center gap-1.5 border-t border-line pt-2.5 text-[11px] font-extrabold text-blood">
                                <span aria-hidden>🔥</span>
                                선착순 마감 임박 · {plan.remainingSlots.toLocaleString('ko-KR')}건 남음
                            </p>
                        ) : available && presentation.referencePriceLabel ? (
                            <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] font-bold text-amber">
                                얼리버드 선착순 한정
                            </p>
                        ) : !available ? (
                            <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] font-medium text-fg-mute">
                                {plan.unavailableReason === 'below_required_plan'
                                    ? '이 계정 규모에서는 이용 가능한 플랜이 아니에요.'
                                    : '아직 오픈 전인 플랜이에요.'}
                            </p>
                        ) : null}
                    </label>
                );
            })}
        </fieldset>
    );
}
