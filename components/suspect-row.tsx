import type { ReactNode } from "react";
import {
  CaseCard,
  DeepRiskAnalysis,
  GradeRail,
  InstaButton,
  MaskedHandle,
  MaskedText,
  RecentMutualBadge,
  RiskTag,
  ThreatBar,
} from "@/components/case-ui";
import { ownerScorePercent } from "@/lib/services/analysis/owner-view-presentation";

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

/**
 * The one-line overview is public copy generated with the candidate's own
 * handle and the target's handle as allowed exceptions to the digit block
 * (see narrative-privacy.ts), so either can appear verbatim in the text. On a
 * shared view that already blurs the row's handle and name, leaving those
 * same identifiers legible inside the overview would defeat the mask.
 */
function maskIdentifiersInOverview(
  text: string,
  identifiers: readonly (string | undefined)[]
): ReactNode {
  const tokens = [...new Set(
    identifiers
      .filter((identifier): identifier is string => Boolean(identifier && identifier.trim()))
      .map((identifier) => identifier.normalize("NFKC"))
  )];
  if (tokens.length === 0) return text;

  const pattern = new RegExp(
    `(${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "giu"
  );
  return text.normalize("NFKC").split(pattern).map((part, index) => (
    index % 2 === 1 ? <MaskedText key={index} value={part} /> : part
  ));
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
  onPreview,
  maskHandle = false,
  targetInstagramId,
}: {
  account: SuspectRowAccount;
  rank: number;
  avatar: ReactNode;
  externalProfileLinks: boolean;
  /** Local detail view used when an external profile URL is unavailable. */
  onPreview?: () => void;
  /**
   * Blurs the account's handle. Used on the shared view, where the reader never
   * consented to being listed.
   *
   * This is a visual mask only — the handle is still in the payload and readable
   * from devtools. Real redaction has to happen where the share response is
   * built, not here.
   */
  maskHandle?: boolean;
  /** The analyzed target's handle, used to mask its occurrences inside oneLineOverview when maskHandle is set. */
  targetInstagramId?: string;
}) {
  const isHighRisk = account.riskGrade === "high_risk";
  // A masked handle plus a link whose href *is* that handle would cancel out, so
  // the profile action goes away with it.
  const showProfileLink = Boolean(account.instagramUrl) && externalProfileLinks && !maskHandle;

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
            {maskHandle ? (
              <MaskedHandle
                value={account.instagramId}
                className="flex-1 text-[15px] font-bold tracking-tight text-fg/90"
              />
            ) : account.instagramUrl ? (
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
              {/* A real name identifies far more directly than a handle does, so
                  on a shared report none of it is left legible. */}
              {account.fullName && (maskHandle
                ? <MaskedText value={account.fullName} />
                : <span>{account.fullName}</span>)}
              {account.fullName && account.bio && " · "}
              {account.bio}
            </p>
          )}
        </div>
      </div>

      {account.recentMutualRank && <RecentMutualBadge rank={account.recentMutualRank} />}

      {account.oneLineOverview && (
        <p className="text-[12.5px] leading-[1.7] text-fg-dim">
          {maskHandle
            ? maskIdentifiersInOverview(account.oneLineOverview, [account.instagramId, targetInstagramId])
            : account.oneLineOverview}
        </p>
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
              className={`num shrink-0 font-extrabold leading-none tracking-tight ${
                isHighRisk
                  ? "text-[21px] text-blood-2"
                  : account.riskGrade === "caution" ? "text-[16px] text-amber" : "text-[16px] text-jade"
              }`}
            >
              {ownerScorePercent(account.displayScore)}
              <span className="text-[11px] font-semibold text-fg-dim">%</span>
            </span>
          )}
        </div>
        {showProfileLink && (
          <InstaButton
            url={account.instagramUrl!}
            emphasis={isHighRisk ? "high" : "default"}
          />
        )}
        {!showProfileLink && onPreview && !maskHandle && (
          <button
            type="button"
            onClick={onPreview}
            className="shrink-0 border border-line px-3 py-2 text-[11px] font-bold text-fg transition-colors hover:border-fg-dim"
          >
            프로필 보기
          </button>
        )}
      </div>
    </div>
  );

  // Both tiers must put their content on the same left and right edges, or the
  // list reads as misaligned when a Tier 2 card sits between plain rows:
  //   Tier 2  1px border + 15px padding      -> content at 16 / W-16
  //   Tier 0  2px rail   + 14px gap, pr-4    -> content at 16 / W-16
  if (isHighRisk) {
    /* The one account the report exists to name. It used to differ from an
       ordinary row only by a border colour, so it read as a variant rather than
       as a finding: a breathing glow and a single sweep on arrival give it the
       weight the number already claims. */
    return (
      <CaseCard
        bracket="var(--color-blood)"
        className="alarm-glow relative my-4 overflow-hidden border-blood/55 px-[15px] py-4"
      >
        <span
          aria-hidden="true"
          className="alarm-sweep pointer-events-none absolute inset-x-0 top-0 h-14"
          style={{
            background:
              'linear-gradient(180deg, transparent, rgb(var(--glow-rgb) / 0.22), transparent)',
          }}
        />
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
