import Image from "next/image";
import Link from "next/link";
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";
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

/* Container tiers
 *
 *   Tier 0  plain      no container; whitespace and a single hairline
 *   Tier 1  Panel      hairline border, no brackets — an operable surface
 *   Tier 2  CaseCard   border + corner brackets — the screen's verdict, used once
 *
 * The brackets are the brand's loudest device. They only read as a signal while
 * they stay rare, so Tier 2 is reserved rather than reached for by default.
 */

/* --- Tier 1: operable surface --- */
export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`border border-line bg-ink-2 ${className}`}>{children}</div>;
}

/* --- Tier 2: bordered dossier card with corner brackets --- */
export function CaseCard({
  children,
  className = "",
  bracket = "var(--color-line-2)",
  ...props
}: {
  children: ReactNode;
  className?: string;
  bracket?: string;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`relative border border-line bg-ink-2 ${className}`}>
      <Corners color={bracket} />
      {children}
    </div>
  );
}

/* --- classification scale --- */
const GRADE_MAP: Record<Grade, { label: string; text: string; mark: string; color: string }> = {
  high_risk: { label: "고위험", text: "text-blood-2", mark: "bg-blood", color: "var(--color-blood)" },
  caution: { label: "주의", text: "text-amber", mark: "bg-amber", color: "var(--color-amber)" },
  normal: { label: "정상", text: "text-jade", mark: "bg-jade", color: "var(--color-jade)" },
};

/* Grade reads as a rotated registration mark plus a word — no box. A border in a
   result row means "this is pressable", and the grade is not. */
export function RiskTag({ grade, className = "" }: { grade: Grade; className?: string }) {
  const g = GRADE_MAP[grade];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[10.5px] font-extrabold tracking-[0.14em] ${g.text} ${className}`}
    >
      <span className={`h-[5px] w-[5px] rotate-45 ${g.mark}`} aria-hidden="true" />
      {g.label}
    </span>
  );
}

/* Full-height rail carrying the row's grade. Rows scanned at speed are read by
   this colour band alone. */
export function GradeRail({ grade, className = "" }: { grade: Grade; className?: string }) {
  return (
    <span
      className={`w-0.5 shrink-0 self-stretch ${GRADE_MAP[grade].mark} ${className}`}
      aria-hidden="true"
    />
  );
}

/* An annotation, not a control.
 *
 * A left rail would read as a second grade: the row's left vertical axis is
 * owned by GradeRail, and on a caution row both would be amber, leaving no way
 * to tell classification from annotation. So this borrows the diamond from
 * RiskTag instead — same mark vocabulary, different axis. */
export function RecentMutualBadge({
  rank,
  className = "",
}: {
  rank: 1 | 2 | 3 | 4 | 5;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 text-[11.5px] font-semibold leading-snug text-amber ${className}`}
    >
      <span className="h-[5px] w-[5px] shrink-0 rotate-45 bg-amber" aria-hidden="true" />
      가장 최근 맞팔한 여자 {rank}번째
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
      <span className="eyebrow text-blood-2">고위험 계정 총평</span>
      <div className="mt-2.5 space-y-2">
        {lines.slice(0, 2).map((line) => (
          <p key={line} className="text-[12.5px] leading-[1.65] text-fg-dim">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/* --- threat meter --- */
/* Rendered as one continuous track rather than ten blocks, but the fill is still
   driven by threatMeterFillCount so the bar and the printed score stay locked to
   the same rounded value. */
export function ThreatBar({
  grade,
  score,
  segments = DEFAULT_THREAT_METER_SEGMENTS,
  className = "",
  fill = "static",
  fillDelayMs = 0,
}: {
  grade: Grade;
  score?: number;
  segments?: number;
  className?: string;
  /**
   * static  — render at the final width (default).
   * pending — hold at zero, waiting for its cue.
   * run     — animate from zero up to the final width.
   */
  fill?: "static" | "pending" | "run";
  fillDelayMs?: number;
}) {
  const filled = threatMeterFillCount({ grade, displayScore: score, segments });
  const ratio = segments > 0 ? filled / segments : 0;
  const width = `${ratio * 100}%`;
  return (
    <div className={`relative h-0.5 w-full bg-line ${className}`} aria-hidden="true">
      <span
        // The meter fills on cue so it reads as a reading being taken rather than
        // a value that was always there. It has to sit at zero until then, or the
        // final width flashes before the animation starts.
        className={`absolute inset-y-0 left-0 ${fill === "run" ? "meter-fill" : ""}`}
        style={{
          background: GRADE_MAP[grade].color,
          ...(fill === "run"
            ? ({
                "--meter-width": width,
                animationDelay: fillDelayMs ? `${fillDelayMs}ms` : undefined,
              } as CSSProperties)
            : { width: fill === "pending" ? 0 : width }),
        }}
      />
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

/* --- placeholder for a profile picture we could not load ---
 *
 * Instagram hands back its own anonymous-avatar URL for accounts that never set
 * a photo, and that host is proxy-allowed, so a genuinely photo-less account
 * already renders Instagram's real default. This only stands in when no URL
 * reached us at all — so it mirrors that default's solid silhouette rather than
 * an outline icon, which read as "failed to load" instead of "no photo".
 *
 * The tone is our own: Instagram's #DBDBDB would be the brightest thing on the
 * page, louder than the crimson accent.
 */
/* Masking for third parties on a shared report.
 *
 * The people listed here never agreed to appear in something the owner can send
 * to anyone. But a page of grey placeholders and solid blurs reads as broken
 * rather than as redacted, so enough is kept to show a real account was found
 * and nothing more: a face you cannot identify, and the first two characters of
 * a handle you cannot complete.
 *
 * Blur is applied to the rendered image, so the underlying source is still in
 * the payload — treat this as presentation, not as a privacy boundary. */

/* Tuned on a 40px avatar. Keep the shared profile visible as an account while
   reducing the previous blur by roughly half. */
export const MASK_AVATAR_BLUR_PX = 3;

/** Text needs less: shapes stay unreadable well before they stop being letters. */
const MASK_TEXT_BLUR_PX = 5;

/** Leading characters left legible on a masked handle. */
const MASK_VISIBLE_CHARS = 2;

/** A name carries more than a handle does, so none of it is left legible. */
export function MaskedText({ value, className = "" }: { value: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block max-w-full select-none truncate align-bottom ${className}`}
      style={{ filter: `blur(${MASK_TEXT_BLUR_PX}px)` }}
    >
      {value}
    </span>
  );
}

export function MaskedHandle({ value, className = "" }: { value: string; className?: string }) {
  const head = value.slice(0, MASK_VISIBLE_CHARS);
  const tail = value.slice(MASK_VISIBLE_CHARS);
  return (
    <span className={`flex min-w-0 items-baseline ${className}`}>
      <span className="shrink-0 whitespace-pre">@{head}</span>
      {tail && (
        <span
          aria-hidden="true"
          className="min-w-0 select-none truncate"
          style={{ filter: `blur(${MASK_TEXT_BLUR_PX}px)` }}
        >
          {tail}
        </span>
      )}
    </span>
  );
}

/** Wraps an avatar so the blur cannot leak past the frame's edge. */
export function MaskedAvatar({ children }: { children: ReactNode }) {
  return (
    <div
      // Scaled up because a blur samples past its own bounds; without it the
      // frame gets a translucent rim of whatever sits behind it.
      className="h-full w-full scale-110"
      style={{ filter: `blur(${MASK_AVATAR_BLUR_PX}px)` }}
    >
      {children}
    </div>
  );
}

export function ProfileFallback({ variant = "person" }: { variant?: "person" | "private" }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-line">
      {variant === "private" ? (
        <svg viewBox="0 0 24 24" className="h-1/2 w-1/2 text-fg-mute" fill="currentColor" aria-hidden="true">
          <path d="M12 2.75A4.25 4.25 0 0 0 7.75 7v2.25H7A1.75 1.75 0 0 0 5.25 11v7A1.75 1.75 0 0 0 7 19.75h10A1.75 1.75 0 0 0 18.75 18v-7A1.75 1.75 0 0 0 17 9.25h-.75V7A4.25 4.25 0 0 0 12 2.75zm2.75 6.5h-5.5V7a2.75 2.75 0 0 1 5.5 0v2.25z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-3/5 w-3/5 text-fg-mute" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="8.6" r="3.9" />
          <path d="M12 14.4c-4.06 0-7.35 2.64-7.35 5.9 0 .6.49 1.09 1.09 1.09h12.52c.6 0 1.09-.49 1.09-1.09 0-3.26-3.29-5.9-7.35-5.9z" />
        </svg>
      )}
    </div>
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

/* --- instagram profile action --- */
export function InstagramGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
    </svg>
  );
}

/* Opening the suspect's profile is the row's real destination, so it gets a
   label and the row's only border. High-risk rows carry the crimson from rest. */
export function InstaButton({
  url,
  emphasis = "default",
  className = "",
}: {
  url: string;
  emphasis?: "default" | "high";
  className?: string;
}) {
  const tone = emphasis === "high"
    ? "border-blood/50 text-blood-2"
    : "border-line-2 text-fg";
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex shrink-0 items-center gap-1.5 border ${tone} px-2.5 py-[7px] text-[11.5px] font-bold whitespace-nowrap transition-colors duration-150 hover:border-blood hover:bg-blood/[0.08] hover:text-blood-2 ${className}`}
    >
      <InstagramGlyph className="h-3.5 w-3.5 shrink-0" />
      프로필 열기
    </a>
  );
}

/* --- ghost / bordered action --- */
export const ghostCls =
  "inline-flex w-full items-center justify-center gap-2 border border-line-2 bg-transparent px-5 py-3.5 text-sm font-bold tracking-tight text-fg transition-colors duration-150 hover:border-fg-dim hover:bg-panel";
