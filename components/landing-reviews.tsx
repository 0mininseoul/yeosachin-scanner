interface Review {
  handle: string;
  body: string;
  when: string;
  tint: string;
}

// Handles often start with punctuation (e.g. "__jiwoo22"), so pick the first
// alphanumeric character for the monogram instead of the literal first char.
function monogram(handle: string): string {
  return (handle.match(/[a-z0-9]/i)?.[0] ?? '@').toUpperCase();
}

// 순수 커뮤니티형 후기(20대 여성 SNS 말투). 문장 길이는 의도적으로 들쭉날쭉하게
// — 아주 짧은 것, 아주 긴 것, 중간을 섞는다.
const REVIEWS: Review[] = [
  {
    handle: 'yerin_._',
    body: '설마 했는데 진짜 1위로 뜬 계정이 있어서 손이 다 떨렸어요.. 그냥 친구라며',
    when: '3시간 전',
    tint: '#3a3048',
  },
  {
    handle: '0_0hazzz',
    body: '재미로 돌린 건데 1위로 뜬 계정 프사 보자마자 심장이 쿵 내려앉았어요.. 생각해보니까 데이트할 때마다 그 언니 얘기가 은근히 자주 나왔었거든요? 그냥 친구라길래 넘겼는데 이제야 퍼즐이 맞춰지는 느낌이에요. 볼 때는 손 떨렸는데, 안 봤으면 계속 모르고 속고 살았을 것 같아서 무서워도 보길 잘했어요',
    when: '어제',
    tint: '#48402e',
  },
  {
    handle: 'nabi.log',
    body: '재미로 돌려봤다가 표정 굳었어요ㅋㅋ',
    when: '5일 전',
    tint: '#2e4842',
  },
  {
    handle: 'minju.grm',
    body: '반신반의로 돌렸는데 비공개까지 다 잡아내는 거 실화예요?',
    when: '2일 전',
    tint: '#4a3136',
  },
  {
    handle: 'dear.sora',
    body: '헤어지고 미련 때문에 뒤늦게 돌려봤는데, 사귈 때 계속 마음에 걸리던 그 계정이 고위험 1위로 딱 떠서 소름이 돋았어요. 몇 번을 물어봐도 예민한 거라던 게 결국 다 제 촉이 맞았던 거더라고요.. 이상한 낌새는 있는데 확신이 없어서 참고 있는 사람들, 제발 늦기 전에 한 번만 돌려봐요',
    when: '1주 전',
    tint: '#3a3048',
  },
  {
    handle: 'seoyeon.day',
    body: '결과 캡쳐해서 단톡방에 바로 공유했어요ㅋㅋㅋ 지금 다들 각자 남친 돌려보는 중이에요',
    when: '1일 전',
    tint: '#48402e',
  },
  {
    handle: '__jiwoo22',
    body: '고위험 뜬 계정 프사가 딱 봐도 느낌 오는 스타일이라 더 소름 돋음',
    when: '4일 전',
    tint: '#2e4842',
  },
  {
    handle: 'somin.ee',
    body: '생각보다 훨씬 디테일해서 놀랐어요. 근거까지 딱딱 나오니까 반박이 안 되네요',
    when: '6일 전',
    tint: '#4a3136',
  },
];

export function LandingReviews() {
  return (
    <div
      className="scroll-thin -mx-5 flex snap-x snap-mandatory items-start gap-3 overflow-x-auto px-5 pb-2"
      style={{ scrollPaddingLeft: '20px' }}
    >
      {REVIEWS.map((r) => (
        <article
          key={r.handle}
          className="flex w-[264px] shrink-0 snap-start flex-col border border-line bg-ink-2 p-4"
        >
          <div className="flex items-center gap-2">
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-fg/70"
              style={{ background: `linear-gradient(140deg, ${r.tint}, #17120f)` }}
              aria-hidden="true"
            >
              {monogram(r.handle)}
            </span>
            <span className="num truncate text-[12px] font-semibold text-fg-dim">@{r.handle}</span>
          </div>
          <p className="mt-3 whitespace-pre-line text-[13px] leading-relaxed text-fg">{r.body}</p>
          <span className="num mt-3 text-[11px] tracking-[0.08em] text-fg-mute">{r.when}</span>
        </article>
      ))}
    </div>
  );
}
