'use client';

import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import { useAuth } from '@/hooks/useAuth';

export default function LandingPage() {
  const router = useRouter();
  const { user } = useAuth();

  const handleStart = () => {
    trackEvent(EVENTS.CLICK_CTA_START);
    if (user) {
      router.push('/analyze');
    } else {
      router.push('/login');
    }
  };

  return (
    <div className="min-h-screen bg-black text-white selection:bg-mint-500/30">
      {/* 네비게이션 */}
      <nav className="fixed top-0 w-full z-50 bg-black/80 backdrop-blur-md border-b border-gray-800">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-8 h-8 bg-gray-900 rounded-full overflow-hidden border border-gray-800">
              <Image
                src="/logo.png"
                alt="AI 위장 여사친 판독기 로고"
                width={32}
                height={32}
                className="w-full h-full object-cover"
                priority
              />
            </div>
            <span className="font-bold text-lg text-mint-500">
              AI 위장 여사친 판독기
            </span>
          </div>
          {user ? (
            <div className="flex gap-4 items-center">
              <button
                onClick={() => router.push('/mypage')}
                className="text-sm font-medium text-gray-300 hover:text-white"
              >
                마이페이지
              </button>
              <button
                onClick={() => router.push('/analyze')}
                className="bg-mint-500 hover:bg-mint-400 text-black text-sm font-bold py-2 px-4 rounded-full transition-colors"
              >
                분석하기
              </button>
            </div>
          ) : (
            <button
              onClick={() => router.push('/login')}
              className="text-sm font-medium text-gray-300 hover:text-white"
            >
              로그인
            </button>
          )}
        </div>
      </nav>

      <main className="max-w-md mx-auto pt-20 pb-10 px-4 flex flex-col items-center">
        {/* 히어로 섹션 */}
        <section className="text-center mb-16 px-2 w-full">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="mb-6"
          >
            <span className="inline-block py-1 px-3 rounded-full bg-mint-500/10 text-mint-400 text-xs font-bold mb-4 border border-mint-500/20">
              🔒 비밀 보장 100%
            </span>
            <h1 className="text-3xl md:text-4xl font-bold leading-tight mb-4">
              내 남친이 맞팔 중인 여자들,<br />
              <span className="text-mint-500">
                누가 제일 위험할까?
              </span>
            </h1>
            <p className="text-gray-400 text-lg">
              &quot;그냥 친구야&quot;라는 말,<br />
              AI가 팩트로 검증해드립니다.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="relative w-full aspect-[4/3] bg-gray-900 rounded-2xl overflow-hidden mb-8 border border-gray-800 shadow-2xl shadow-mint-500/10"
          >
            {/* 예시 결과 화면 (가상) */}
            <div className="absolute inset-0 flex flex-col p-4">
              <div className="flex items-center justify-between mb-4">
                <div className="text-xs text-gray-400">분석 결과 리포트</div>
                <div className="text-xs text-red-400 font-bold">🔴 고위험군 감지</div>
              </div>
              <div className="space-y-3">
                <div className="bg-gray-800/80 rounded-xl p-3 flex items-center gap-3 backdrop-blur-sm border border-point-red/30">
                  <div className="w-10 h-10 rounded-full bg-gray-700 overflow-hidden relative">
                    <div className="absolute inset-0 bg-point-red/20 backdrop-blur-[2px]"></div>
                  </div>
                  <div className="flex-1">
                    <div className="h-3 w-20 bg-gray-600 rounded mb-1.5"></div>
                    <div className="h-2 w-12 bg-point-red/50 rounded"></div>
                  </div>
                  <div className="text-xl">🚨</div>
                </div>
                <div className="bg-gray-800/50 rounded-xl p-3 flex items-center gap-3 backdrop-blur-sm">
                  <div className="w-10 h-10 rounded-full bg-gray-700"></div>
                  <div className="flex-1">
                    <div className="h-3 w-16 bg-gray-600 rounded mb-1.5"></div>
                    <div className="h-2 w-10 bg-orange-500/50 rounded"></div>
                  </div>
                  <div className="text-xl">⚠️</div>
                </div>
                <div className="bg-gray-800/30 rounded-xl p-3 flex items-center gap-3 backdrop-blur-sm">
                  <div className="w-10 h-10 rounded-full bg-gray-700"></div>
                  <div className="flex-1">
                    <div className="h-3 w-24 bg-gray-600 rounded mb-1.5"></div>
                    <div className="h-2 w-8 bg-mint-500/50 rounded"></div>
                  </div>
                  <div className="text-xl">✅</div>
                </div>
              </div>

              {/* 오버레이 텍스트 */}
              <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent flex items-end justify-center pb-4">
                <p className="text-sm font-medium text-gray-300">
                  AI가 인스타그램 계정을 분석합니다
                </p>
              </div>
            </div>
          </motion.div>

          <button
            onClick={handleStart}
            className="w-full bg-mint-500 text-black font-bold text-lg py-4 rounded-xl shadow-lg shadow-mint-500/20 hover:bg-mint-400 hover:scale-[1.02] transition-all active:scale-[0.98]"
          >
            지금 바로 분석하기 ✨
          </button>
          <p className="mt-3 text-xs text-gray-500">
            * 분석 결과는 당사자에게 절대 알림이 가지 않습니다.
          </p>
        </section>

        {/* 3단계 프로세스 */}
        <section className="w-full mb-16 space-y-8">
          <h2 className="text-xl font-bold text-center mb-8">
            어떻게 분석하나요?
          </h2>

          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-gray-900 flex items-center justify-center text-2xl flex-shrink-0 border border-gray-800">
              📝
            </div>
            <div>
              <h3 className="font-bold text-lg mb-1">1. 정보 입력</h3>
              <p className="text-gray-400 text-sm">
                남자친구의 인스타그램 아이디만 입력하세요.<br />
                (비밀번호는 절대 요구하지 않아요!)
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-gray-900 flex items-center justify-center text-2xl flex-shrink-0 border border-gray-800">
              🤖
            </div>
            <div>
              <h3 className="font-bold text-lg mb-1">2. AI 정밀 분석</h3>
              <p className="text-gray-400 text-sm">
                팔로워 목록을 스캔하여 성별을 식별하고,<br />
                계정의 분위기, 태그, 남자친구와의 상호작용 등을 복합적으로 분석합니다.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-gray-900 flex items-center justify-center text-2xl flex-shrink-0 border border-gray-800">
              📊
            </div>
            <div>
              <h3 className="font-bold text-lg mb-1">3. 결과 리포트</h3>
              <p className="text-gray-400 text-sm">
                위험도가 높은 &apos;위장 여사친&apos; 후보를<br />
                순위별로 확인해보세요.
              </p>
            </div>
          </div>
        </section>

        {/* 리뷰 섹션 */}
        <section className="w-full mb-16">
          <h2 className="text-xl font-bold text-center mb-8">
            이미 많은 분들이 확인했어요
          </h2>

          <div className="space-y-4">
            <div className="bg-gray-900 p-5 rounded-2xl border border-gray-800 relative">
              <span className="absolute top-4 right-4 text-gray-600 text-xs">어제</span>
              <div className="flex text-mint-500 mb-2">★★★★★</div>
              <p className="text-gray-300 text-sm leading-relaxed mb-3">
                &quot;그냥 아는 동생이라던 애가 있었는데, AI 분석 결과에서 고위험군 1위로 뜨더라고요. 혹시나 해서 봤더니...ㅎ 진짜 소름&quot;
              </p>
              <p className="text-gray-500 text-xs">- 23세 대학생 김OO님</p>
            </div>

            <div className="bg-gray-900 p-5 rounded-2xl border border-gray-800 relative">
              <span className="absolute top-4 right-4 text-gray-600 text-xs">2일 전</span>
              <div className="flex text-mint-500 mb-2">★★★★★</div>
              <p className="text-gray-300 text-sm leading-relaxed mb-3">
                &quot;비공개 계정까지 리스트로 쫙 뽑아줘서 좋았어요. 내가 모르는 여자가 이렇게 많은 줄 몰랐음.&quot;
              </p>
              <p className="text-gray-500 text-xs">- 26세 직장인 이OO님</p>
            </div>
          </div>
        </section>

        {/* 하단 CTA */}
        <section className="w-full text-center mb-10">
          <div className="bg-gradient-to-br from-gray-900 to-gray-800 p-8 rounded-3xl border border-gray-700">
            <h2 className="text-xl font-bold mb-4">
              더 늦기 전에 확인해보세요
            </h2>
            <p className="text-gray-400 text-sm mb-6">
              불안해하며 시간 낭비하지 마세요.<br />
              AI가 3분 만에 진실을 알려드립니다.
            </p>
            <button
              onClick={handleStart}
              className="bg-white text-black font-bold py-3.5 px-8 rounded-xl hover:bg-gray-100 transition-colors"
            >
              무료로 시작하기 👉
            </button>
          </div>
        </section>

        {/* 푸터 */}
        <footer className="text-center text-gray-600 text-xs space-y-2 py-8 border-t border-gray-900 w-full">
          <p>AI 위장 여사친 판독기</p>
          <p>
            본 서비스는 AI 기술을 활용하여 공개된 정보를 분석합니다.<br />
            분석 결과는 100% 정확성을 보장하지 않으며,<br />
            재미 목적으로만 이용해주시기 바랍니다.
          </p>
          <div className="flex justify-center gap-4 mt-4 text-gray-500">
            <Link href="/terms" className="hover:text-gray-300">이용약관</Link>
            <Link href="/privacy" className="hover:text-gray-300">개인정보처리방침</Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
