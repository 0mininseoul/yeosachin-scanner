import Image from "next/image";
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  DEFAULT_THREAT_METER_SEGMENTS,
  threatMeterFillCount,
} from "@/lib/services/analysis/owner-view-presentation";

/* ============================================================
   CASE FILE — shared dossier primitives
   ============================================================ */

type Grade = "high_risk" | "caution" | "normal";

/* --- brand reticle mark --- */
export function BrandMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <circle cx="12" cy="12" r="4.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 1.5v4.2M12 18.3v4.2M1.5 12h4.2M18.3 12h4.2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="12" r="1.7" fill="var(--color-blood)" />
    </svg>
  );
}

/* --- brand wordmark lockup --- */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <BrandMark className="text-blood" />
      <span className="text-[15px] font-extrabold leading-none tracking-tight text-fg">
        위장여사친 <span className="text-blood">판독기</span>
      </span>
    </span>
  );
}

/* --- sticky top bar shell --- */
export function TopBar({ right, home = true }: { right?: ReactNode; home?: boolean }) {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-ink/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[460px] items-center justify-between px-5">
        {home ? (
          <Link href="/" className="shrink-0">
            <Wordmark />
          </Link>
        ) : (
          <Wordmark />
        )}
        {right ? <div className="flex items-center gap-4">{right}</div> : null}
      </div>
    </header>
  );
}

/* --- eyebrow / section label with leading blood tick --- */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="h-[7px] w-[7px] shrink-0 bg-blood" />
      <span className="eyebrow">{children}</span>
    </span>
  );
}

/* --- registration corner brackets --- */
function Corners({ color }: { color: string }) {
  const c = `pointer-events-none absolute h-2.5 w-2.5`;
  return (
    <>
      <span className={`${c} left-[-1px] top-[-1px] border-l border-t`} style={{ borderColor: color }} />
      <span className={`${c} right-[-1px] top-[-1px] border-r border-t`} style={{ borderColor: color }} />
      <span className={`${c} bottom-[-1px] left-[-1px] border-b border-l`} style={{ borderColor: color }} />
      <span className={`${c} bottom-[-1px] right-[-1px] border-b border-r`} style={{ borderColor: color }} />
    </>
  );
}

/* --- bordered dossier card with corner brackets --- */
export function CaseCard({
  children,
  className = "",
  bracket = "var(--color-line-2)",
}: {
  children: ReactNode;
  className?: string;
  bracket?: string;
}) {
  return (
    <div className={`relative border border-line bg-ink-2 ${className}`}>
      <Corners color={bracket} />
      {children}
    </div>
  );
}

/* --- classification tag --- */
const GRADE_MAP: Record<Grade, { label: string; text: string; border: string; bg: string; dot: string }> = {
  high_risk: { label: "고위험", text: "text-blood", border: "border-blood/45", bg: "bg-blood/10", dot: "bg-blood" },
  caution: { label: "주의", text: "text-amber", border: "border-amber/45", bg: "bg-amber/10", dot: "bg-amber" },
  normal: { label: "정상", text: "text-jade", border: "border-jade/45", bg: "bg-jade/10", dot: "bg-jade" },
};

export function RiskTag({ grade, className = "" }: { grade: Grade; className?: string }) {
  const g = GRADE_MAP[grade];
  return (
    <span
      className={`inline-flex items-center gap-1.5 border ${g.border} ${g.bg} px-2 py-[3px] text-[10px] font-bold tracking-[0.14em] ${g.text} ${className}`}
    >
      <span className={`h-1.5 w-1.5 ${g.dot}`} />
      {g.label}
    </span>
  );
}

export function RecentMutualBadge({
  rank,
  className = "",
}: {
  rank: 1 | 2 | 3 | 4 | 5;
  className?: string;
}) {
  const label = `가장 최근 맞팔한 여자 ${rank}번째`;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 border border-amber/45 bg-amber/10 px-2 py-1 text-[10px] font-bold text-amber ${className}`}
      title={label}
      aria-label={label}
    >
      <span className="h-1.5 w-1.5 shrink-0 bg-amber" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function DeepRiskAnalysis({
  lines,
  className = "",
}: {
  lines: string[];
  className?: string;
}) {
  if (lines.length === 0) return null;

  return (
    <div className={`border-t border-line pt-3 ${className}`}>
      <span className="eyebrow text-blood">고위험 계정 총평</span>
      <ol className="mt-2 space-y-2">
        {lines.slice(0, 2).map((line, index) => (
          <li key={line} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2">
            <span className="num pt-0.5 text-[10px] font-bold text-blood" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <p className="text-[12px] leading-[1.65] text-fg-dim">{line}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* --- segmented threat meter --- */
export function ThreatBar({
  grade,
  score,
  segments = DEFAULT_THREAT_METER_SEGMENTS,
  className = "",
}: {
  grade: Grade;
  score?: number;
  segments?: number;
  className?: string;
}) {
  const colorMap: Record<Grade, string> = {
    high_risk: "var(--color-blood)",
    caution: "var(--color-amber)",
    normal: "var(--color-jade)",
  };
  const filled = threatMeterFillCount({ grade, displayScore: score, segments });
  const color = colorMap[grade];
  return (
    <div className={`flex items-center gap-[3px] ${className}`} aria-hidden="true">
      {Array.from({ length: segments }).map((_, i) => (
        <span
          key={i}
          className="h-2.5 flex-1"
          style={{
            background: i < filled ? color : "var(--color-line)",
            boxShadow: i < filled ? `0 0 6px color-mix(in srgb, ${color} 40%, transparent)` : "none",
          }}
        />
      ))}
    </div>
  );
}

/* --- rotated stamp --- */
export function Stamp({
  children,
  tone = "blood",
  className = "",
}: {
  children: ReactNode;
  tone?: "blood" | "fg";
  className?: string;
}) {
  const c = tone === "blood" ? "border-blood text-blood" : "border-fg-dim text-fg-dim";
  return (
    <span
      className={`inline-block border-2 ${c} px-2 py-1 text-[11px] font-extrabold tracking-[0.18em] ${className}`}
    >
      {children}
    </span>
  );
}

/* --- redaction bar --- */
export function Redaction({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      className={`inline-block h-[0.92em] w-24 max-w-full translate-y-[0.12em] bg-fg/85 ${className}`}
      style={style}
      aria-hidden="true"
    />
  );
}

/* --- circular photo avatar for a suspect row --- */
export function SuspectAvatar({
  src,
  size = 40,
  className = "",
}: {
  src: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`relative block shrink-0 overflow-hidden rounded-full border border-line-2 bg-panel ${className}`}
      style={{ height: size, width: size }}
      aria-hidden="true"
    >
      <Image src={src} alt="" fill sizes={`${size}px`} className="object-cover" />
    </span>
  );
}

/* --- primary crimson action --- */
const primaryBase =
  "group relative inline-flex w-full items-center justify-center gap-2 border border-blood bg-blood font-extrabold tracking-tight text-white transition-[transform,background,box-shadow] duration-150 hover:bg-blood-2 hover:shadow-[0_0_28px_-6px_var(--color-blood)] active:scale-[0.99] disabled:cursor-not-allowed disabled:border-line disabled:bg-panel disabled:text-fg-mute disabled:shadow-none";

const primarySizes = {
  md: "px-5 py-4 text-[15px]",
  lg: "px-6 py-[18px] text-[18px]",
} as const;

export const primaryCls = `${primaryBase} ${primarySizes.md}`;

export function PrimaryButton({
  children,
  className = "",
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { size?: "md" | "lg" }) {
  return (
    <button className={`${primaryBase} ${primarySizes[size]} ${className}`} {...props}>
      {children}
    </button>
  );
}

/* --- ghost / bordered action --- */
export const ghostCls =
  "inline-flex w-full items-center justify-center gap-2 border border-line-2 bg-transparent px-5 py-3.5 text-sm font-bold tracking-tight text-fg transition-colors duration-150 hover:border-fg-dim hover:bg-panel";
