'use client';

import { useId, useRef, useState } from 'react';
import { RESULT_FEEDBACK_MAX_LENGTH } from '@/lib/services/feedback/contracts';
import { EVENTS, trackEvent } from '@/lib/services/analytics';

type Phase = 'closed' | 'open' | 'sending' | 'sent';

/* A quiet escape hatch at the end of the report: the reader has just been told
 * something about their relationship, and disagreeing with it needs somewhere to
 * go. Collapsed by default so it never competes with the verdict. */
export function ResultFeedback({ requestId }: { requestId: string }) {
  const [phase, setPhase] = useState<Phase>('closed');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();

  const open = () => {
    setPhase('open');
    setError(null);
    // Focus after the field exists.
    window.requestAnimationFrame(() => fieldRef.current?.focus());
  };

  const submit = async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      setError('어떤 점이 부정확한지 알려주세요.');
      fieldRef.current?.focus();
      return;
    }
    setPhase('sending');
    setError(null);
    try {
      const response = await fetch('/api/result-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, body: trimmed }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? '의견을 저장하지 못했습니다.');
      }
      trackEvent(EVENTS.RESULT_FEEDBACK_SUBMITTED, { request_id: requestId });
      setPhase('sent');
      setBody('');
    } catch (err) {
      setPhase('open');
      setError(err instanceof Error ? err.message : '의견을 저장하지 못했습니다.');
    }
  };

  if (phase === 'sent') {
    return (
      <p className="mt-8 text-center text-[12px] text-fg-dim" role="status">
        의견 감사합니다. 판독 품질을 개선하는 데 쓰겠습니다.
      </p>
    );
  }

  if (phase === 'closed') {
    return (
      <div className="mt-8 text-center">
        <button
          type="button"
          onClick={open}
          className="text-[12px] text-fg-dim underline decoration-line-2 underline-offset-4 transition-colors hover:text-fg hover:decoration-fg-dim"
        >
          결과가 정확하지 않나요?
        </button>
      </div>
    );
  }

  const sending = phase === 'sending';
  const remaining = RESULT_FEEDBACK_MAX_LENGTH - body.length;

  return (
    <div className="mt-8 border-t border-line pt-5">
      <label htmlFor={fieldId} className="label-ko block">
        어떤 점이 부정확한가요?
      </label>
      <p className="mt-1.5 text-[12px] leading-relaxed text-fg-dim">
        판독이 어긋난 부분을 적어 주시면 개선에 반영합니다.
      </p>
      <textarea
        data-amp-mask
        id={fieldId}
        ref={fieldRef}
        value={body}
        onChange={(event) => {
          setBody(event.target.value.slice(0, RESULT_FEEDBACK_MAX_LENGTH));
          if (error) setError(null);
        }}
        rows={4}
        maxLength={RESULT_FEEDBACK_MAX_LENGTH}
        disabled={sending}
        placeholder="예) 1위로 나온 계정은 사촌 누나예요."
        className="mt-3 w-full resize-y border border-line bg-ink px-3 py-2.5 text-[13px] leading-relaxed text-fg placeholder-fg-mute transition-colors focus:border-blood focus:outline-none disabled:opacity-50"
      />
      <div className="mt-1.5 flex items-baseline justify-between gap-3">
        <span data-amp-mask className="text-[11px] text-blood-2" role="alert">
          {error ?? ' '}
        </span>
        <span className="num shrink-0 text-[11px] text-fg-dim">{remaining}</span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={sending}
          className="inline-flex items-center gap-2 border border-blood bg-blood px-4 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-blood-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sending && (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          )}
          {sending ? '보내는 중…' : '의견 보내기'}
        </button>
        <button
          type="button"
          onClick={() => {
            setPhase('closed');
            setError(null);
          }}
          disabled={sending}
          className="px-3 py-2.5 text-[12px] font-medium text-fg-dim transition-colors hover:text-fg disabled:opacity-50"
        >
          취소
        </button>
      </div>
    </div>
  );
}
