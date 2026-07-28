import type { ReactNode } from "react";
import {
  CaseCard,
  DeepRiskAnalysis,
  GradeRail,
  InstaButton,
  RecentMutualBadge,
  RiskTag,
  ThreatBar,
} from "@/components/case-ui";
import { roundedOwnerScore } from "@/lib/services/analysis/owner-view-presentation";

type Grade = "high_risk" | "caution" | "normal";

export interface SuspectRowAccount {
  instagramId: string;
  fullName?: string;
  bio?: string;
  riskGrade: Grade;
  recentMutualRank?: 1 | 2 | 3 | 4 | 5;
  riskAnalysis: string[];
  oneLineOverview?: string;
  displayScore?: number;
  instagramUrl?: string;
}

/* One screened account.
 *
 * Container tier encodes severity rather than decorating every row equally:
 * high-risk rows are the page's verdict and keep the bordered dossier card with
 * corner brackets; everything else is a plain list row carrying its grade in a
 * left rail. That leaves the profile button as the only bordered element in an
 * ordinary row, so "has a border" reliably means "is pressable".
 */
export function SuspectRow({
  account,
  rank,
  avatar,
  externalProfileLinks,
}: {
  account: SuspectRowAccount;
  rank: number;
  avatar: ReactNode;
  externalProfileLinks: boolean;
}) {
  const isHighRisk = account.riskGrade === "high_risk";
  const showProfileLink = Boolean(account.instagramUrl) && externalProfileLinks;

  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      <div className="flex items-start gap-3">
        <div
          className={`relative h-10 w-10 shrink-0 overflow-hidden border bg-panel ${
            isHighRisk ? "border-blood/40" : "border-line"
          }`}
        >
          {avatar}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="num shrink-0 text-[11px] font-bold tracking-[0.1em] text-fg-mute">
              {String(rank).padStart(2, "0")}
            </span>
            {account.instagramUrl ? (
              <a
                href={account.instagramUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-[15px] font-bold tracking-tight text-fg transition-colors hover:text-blood"
              >
                @{account.instagramId}
              </a>
            ) : (
              <span className="truncate text-[15px] font-bold tracking-tight text-fg">
                @{account.instagramId}
              </span>
            )}
            <RiskTag grade={account.riskGrade} className="ml-auto shrink-0" />
          </div>
          {(account.fullName || account.bio) && (
            <p className="mt-0.5 truncate text-[12px] text-fg-dim">
              {account.fullName && <span>{account.fullName}</span>}
              {account.fullName && account.bio && " · "}
              {account.bio}
            </p>
          )}
        </div>
      </div>

      {account.recentMutualRank && <RecentMutualBadge rank={account.recentMutualRank} />}

      {account.oneLineOverview && (
        <p className="text-[12.5px] leading-[1.7] text-fg-dim">{account.oneLineOverview}</p>
      )}

      {isHighRisk && account.riskAnalysis.length > 0 && (
        <DeepRiskAnalysis lines={account.riskAnalysis} />
      )}

      {/* The meter and its readout are one unit, so they sit close together and
          the profile action is pushed clear of them. The score is the row's
          quantified verdict and outweighs the button that follows it. */}
      <div className="mt-1 flex items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <ThreatBar
            grade={account.riskGrade}
            score={account.displayScore}
            className="flex-1"
          />
          {account.displayScore !== undefined && (
            <span
              className={`num shrink-0 text-[16px] font-extrabold leading-none tracking-tight ${
                isHighRisk ? "text-blood-2" : account.riskGrade === "caution" ? "text-amber" : "text-jade"
              }`}
            >
              {roundedOwnerScore(account.displayScore)}
              <span className="text-[11px] font-semibold text-fg-dim">/10</span>
            </span>
          )}
        </div>
        {showProfileLink && (
          <InstaButton
            url={account.instagramUrl!}
            emphasis={isHighRisk ? "high" : "default"}
          />
        )}
      </div>
    </div>
  );

  // Both tiers must put their content on the same left and right edges, or the
  // list reads as misaligned when a Tier 2 card sits between plain rows:
  //   Tier 2  1px border + 15px padding      -> content at 16 / W-16
  //   Tier 0  2px rail   + 14px gap, pr-4    -> content at 16 / W-16
  if (isHighRisk) {
    return (
      <CaseCard bracket="var(--color-blood)" className="my-3.5 border-blood/40 px-[15px] py-4">
        {body}
      </CaseCard>
    );
  }

  return (
    <div className="flex gap-3.5 border-b border-line py-4 pr-4">
      <GradeRail grade={account.riskGrade} />
      {body}
    </div>
  );
}
