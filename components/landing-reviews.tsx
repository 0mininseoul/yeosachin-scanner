interface Review {
  handle: string;
  body: string;
  when: string;
}

// 순수 커뮤니티형 후기(20대 여성 SNS 말투). 문장 길이는 의도적으로 들쭉날쭉하게
// — 아주 짧은 것, 아주 긴 것, 중간을 섞는다.
const REVIEWS: Review[] = [
  {
    handle: 'yerin_._',
    body: '설마 하고 돌려봤는데 진짜 1위로 딱 뜬 계정 보고 손이 다 떨렸어ㅋㅋ 그냥 친구라매...^^;;',
    when: '3시간 전',
  },
  {
    handle: '0_0hazzz',
    body: '그냥 재미로 해본건데 1위로 뜬 계정 프사 보자마자 심장이 쿵 내려앉았어요 ㅠㅠ 생각해보니까 데이트할 때마다 그 언니 얘기가 은근 자주 나왔었거든요..? 친구라길래 그냥 넘겼는데 이제야 하나하나 퍼즐이 맞춰지는 느낌이라 더 소름.. 볼 때는 무서웠는데 안 봤으면 계속 모르고 속고 살았을 거 같아서 그래도 보길 잘한 거 같아요',
    when: '어제',
  },
  {
    handle: 'nabi.log',
    body: '재미로 돌렸다가 표정 관리 실패ㅋㅋㅋㅋ',
    when: '5일 전',
  },
  {
    handle: 'minju.grm',
    body: '반신반의로 해봤는데 비공개 계정까지 싹 잡아내고 왜 위험한지 근거까지 나오는 거 실화예요..? 반박을 못 하겠어요 ㅋㅋㅋㅠㅠ',
    when: '2일 전',
  },
  {
    handle: 'dear.sora',
    body: '헤어지고 미련 때문에 뒤늦게 돌려봤는데 사귈 때 계속 마음에 걸리던 그 계정이 고위험 1위로 딱 떠서 진짜 소름이 쫙.. 몇 번을 물어봐도 예민한 거라던 게 결국 다 제 촉이 맞았던 거더라구요 ㅠㅠ 지금 뭔가 이상한 낌새는 있는데 확신이 없어서 참고 있는 분들, 제발 늦기 전에 딱 한 번만 돌려봐요 진짜로',
    when: '1주 전',
  },
  {
    handle: 'seoyeon.day',
    body: '결과 캡쳐해서 단톡방에 바로 공유했어요ㅋㅋㅋ 지금 다들 각자 남친 돌려보는 중이에요',
    when: '1일 전',
  },
  {
    handle: '__jiwoo22',
    body: '고위험 1위가 남친이 그냥 아는 동생이랬던 그 계정이라 손이 다 떨렸어요.. 프사부터 딱 느낌 오더라구요',
    when: '4일 전',
  },
  {
    handle: 'somin.ee',
    body: '상대한텐 통보 안 간다길래 돌려봤는데 생각보다 개디테일해서 놀람ㅠㅠ',
    when: '6일 전',
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
          <span className="num block truncate text-[12px] font-semibold text-fg-dim">@{r.handle}</span>
          <p className="mt-3 whitespace-pre-line text-[13px] leading-relaxed text-fg">{r.body}</p>
          <span className="num mt-3 text-[11px] tracking-[0.08em] text-fg-mute">{r.when}</span>
        </article>
      ))}
    </div>
  );
}
