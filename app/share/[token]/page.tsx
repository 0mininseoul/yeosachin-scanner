'use client';

import { useEffect, useState, use } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { trackEvent, EVENTS } from '@/lib/services/analytics';

interface PageProps {
    params: Promise<{ token: string }>;
}

// Instagram CDN URL을 프록시 URL로 변환
const getProxyImageUrl = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    if (url.startsWith('/api/image-proxy')) return url;
    return `/api/image-proxy?url=${encodeURIComponent(url)}`;
};

// 프로필 이미지 컴포넌트 (로드 실패 시 fallback)
function ProfileImage({
    src,
    fallbackIcon,
    className = "w-full h-full object-cover"
}: {
    src?: string;
    fallbackIcon: string;
    className?: string;
}) {
    const [error, setError] = useState(false);
    const proxiedSrc = getProxyImageUrl(src);

    if (!proxiedSrc || error) {
        return (
            <div className="w-full h-full flex items-center justify-center text-xl">
                {fallbackIcon}
            </div>
        );
    }

    return (
        <Image
            src={proxiedSrc}
            alt=""
            width={48}
            height={48}
            unoptimized
            className={className}
            onError={() => setError(true)}
        />
    );
}

interface GenderRatio {
    male: { count: number; percentage: number };
    female: { count: number; percentage: number };
    unknown: { count: number; percentage: number };
}

interface FemaleAccount {
    instagramId: string;
    fullName?: string;
    profileImage?: string;
    instagramUrl: string;
    riskGrade: 'high_risk' | 'caution' | 'normal';
    bio: string;
}

interface PrivateAccount {
    instagramId: string;
    fullName?: string;
    profileImage?: string;
    instagramUrl: string;
}

interface ResultData {
    requestId: string;
    status: string;
    isShared: boolean;
    summary: {
        targetInstagramId: string;
        mutualFollows: number;
        genderRatio: GenderRatio;
    };
    femaleAccounts: FemaleAccount[];
    privateAccounts: PrivateAccount[];
}

const getRiskGradeStyle = (grade: string) => {
    switch (grade) {
        case 'high_risk':
            return {
                bg: 'bg-red-500/20',
                text: 'text-red-400',
                border: 'border-red-500/30',
                label: '고위험군',
            };
        case 'caution':
            return {
                bg: 'bg-orange-500/20',
                text: 'text-orange-400',
                border: 'border-orange-500/30',
                label: '주의',
            };
        default:
            return {
                bg: 'bg-green-500/20',
                text: 'text-green-400',
                border: 'border-green-500/30',
                label: '보통',
            };
    }
};

export default function ShareResultPage({ params }: PageProps) {
    const { token } = use(params);
    const [data, setData] = useState<ResultData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();

    useEffect(() => {
        const fetchResult = async () => {
            try {
                const response = await fetch(`/api/share/${token}`);
                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error || '결과를 불러올 수 없습니다.');
                }

                setData(result);
                trackEvent(EVENTS.VIEW_RESULT, {
                    femaleCount: result.femaleAccounts?.length,
                    isShared: true,
                });
            } catch (err) {
                setError(err instanceof Error ? err.message : '결과를 불러오는데 실패했습니다.');
            } finally {
                setLoading(false);
            }
        };

        fetchResult();
    }, [token]);

    const handleShare = async () => {
        trackEvent(EVENTS.CLICK_SHARE_KAKAO);

        const url = window.location.href;
        const shareData = {
            title: 'AI 위장 여사친 판독기 분석 결과',
            text: `${data?.summary.targetInstagramId}님의 인스타 분석 결과를 확인해보세요!`,
            url: url,
        };

        if (navigator.share) {
                try {
                    await navigator.share(shareData);
                    return;
                } catch {
                    // fallback
                }
            }

        try {
            await navigator.clipboard.writeText(url);
            alert('링크가 클립보드에 복사되었습니다!');
        } catch {
            alert('공유하기에 실패했습니다.');
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-pink-400 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
                <p className="text-red-400 mb-4">{error}</p>
                <button
                    onClick={() => router.push('/')}
                    className="bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold py-3 px-6 rounded-xl"
                >
                    서비스 이용하기
                </button>
            </div>
        );
    }

    const { summary, femaleAccounts, privateAccounts } = data;

    return (
        <div className="min-h-screen bg-black text-white pb-20">
            {/* 헤더 - 공유 페이지용 (로그인 버튼 없음) */}
            <div className="p-4 border-b border-gray-800 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <span className="text-2xl">🔍</span>
                    <h1 className="font-bold">분석 결과</h1>
                </div>
                <Link
                    href="/"
                    className="text-pink-400 hover:text-pink-300 text-sm font-medium"
                >
                    나도 분석해보기 →
                </Link>
            </div>

            {/* 성별 비율 리포트 */}
            <div className="p-4">
                <div className="bg-gradient-to-r from-pink-900/30 to-purple-900/30 rounded-2xl p-4 mb-4 border border-pink-500/20">
                    <p className="text-gray-400 text-sm mb-3">
                        @{summary.targetInstagramId} 맞팔 계정 성별 분석
                    </p>
                    <div className="flex items-center justify-center gap-4 text-sm">
                        <div className="text-center">
                            <span className="text-2xl">👨</span>
                            <div className="font-bold">{summary.genderRatio.male.count}명</div>
                            <div className="text-gray-500 text-xs">{summary.genderRatio.male.percentage}%</div>
                        </div>
                        <div className="text-gray-600">│</div>
                        <div className="text-center">
                            <span className="text-2xl">👩</span>
                            <div className="font-bold text-pink-400">{summary.genderRatio.female.count}명</div>
                            <div className="text-gray-500 text-xs">{summary.genderRatio.female.percentage}%</div>
                        </div>
                        <div className="text-gray-600">│</div>
                        <div className="text-center">
                            <span className="text-2xl">❓</span>
                            <div className="font-bold">{summary.genderRatio.unknown.count}명</div>
                            <div className="text-gray-500 text-xs">{summary.genderRatio.unknown.percentage}%</div>
                        </div>
                    </div>
                </div>

                {/* 2컬럼 레이아웃 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* 여성 계정 리스트 */}
                    <div className="bg-gray-900 rounded-2xl p-4">
                        <h3 className="font-bold mb-4 flex items-center gap-2">
                            👩 남자친구가 맞팔 중인 여자들
                            <span className="text-pink-400">{femaleAccounts.length}명</span>
                        </h3>

                        {femaleAccounts.length === 0 ? (
                            <p className="text-gray-500 text-center py-8">
                                분석된 여성 계정이 없습니다.
                            </p>
                        ) : (
                            <div className="space-y-3 max-h-[400px] overflow-y-auto">
                                {femaleAccounts.map((account) => {
                                    const style = getRiskGradeStyle(account.riskGrade);
                                    return (
                                        <div
                                            key={account.instagramId}
                                            className={`${style.bg} border ${style.border} rounded-xl p-3`}
                                        >
                                            <div className="flex items-start gap-3">
                                                {/* 프로필 이미지 */}
                                                <div className="w-12 h-12 bg-gray-800 rounded-full flex-shrink-0 overflow-hidden">
                                                    <ProfileImage
                                                        src={account.profileImage}
                                                        fallbackIcon="👤"
                                                    />
                                                </div>

                                                {/* 정보 */}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <a
                                                            href={account.instagramUrl}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="font-bold text-white hover:text-pink-400 truncate"
                                                        >
                                                            @{account.instagramId}
                                                        </a>
                                                        <span className={`text-xs ${style.text} whitespace-nowrap`}>
                                                            {style.label}
                                                        </span>
                                                    </div>
                                                    {(account.fullName || account.bio) && (
                                                        <p className="text-gray-400 text-sm truncate">
                                                            {account.fullName && <span>{account.fullName}</span>}
                                                            {account.fullName && account.bio && ' · '}
                                                            {account.bio}
                                                        </p>
                                                    )}
                                                </div>

                                                {/* 인스타 링크 */}
                                                <a
                                                    href={account.instagramUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-gray-500 hover:text-pink-400"
                                                >
                                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                                        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
                                                    </svg>
                                                </a>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* 비공개 계정 리스트 */}
                    <div className="bg-gray-900 rounded-2xl p-4">
                        <h3 className="font-bold mb-4 flex items-center gap-2">
                            🔒 남자친구가 맞팔 중인 비공개 계정
                            <span className="text-amber-400">{privateAccounts.length}개</span>
                        </h3>

                        {privateAccounts.length === 0 ? (
                            <p className="text-gray-500 text-center py-8">
                                비공개 계정이 없습니다.
                            </p>
                        ) : (
                            <div className="space-y-3 max-h-[400px] overflow-y-auto">
                                {privateAccounts.map((account) => (
                                    <div
                                        key={account.instagramId}
                                        className="bg-gray-800/50 border border-gray-700 rounded-xl p-3"
                                    >
                                        <div className="flex items-center gap-3">
                                            {/* 프로필 이미지 */}
                                            <div className="w-10 h-10 bg-gray-700 rounded-full flex-shrink-0 overflow-hidden">
                                                <ProfileImage
                                                    src={account.profileImage}
                                                    fallbackIcon="🔒"
                                                />
                                            </div>

                                            {/* ID */}
                                            <div className="flex-1 min-w-0">
                                                <a
                                                    href={account.instagramUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="font-medium text-gray-300 hover:text-white truncate block"
                                                >
                                                    @{account.instagramId}
                                                </a>
                                                {account.fullName && (
                                                    <p className="text-gray-500 text-xs truncate">{account.fullName}</p>
                                                )}
                                            </div>

                                            {/* 인스타 링크 */}
                                            <a
                                                href={account.instagramUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-gray-500 hover:text-white"
                                            >
                                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                                    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
                                                </svg>
                                            </a>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        <p className="text-xs text-gray-500 mt-4">
                            * 비공개 계정은 분석이 불가합니다. 직접 확인이 필요해요.
                        </p>
                    </div>
                </div>

                {/* 공유하기 + 나도 분석해보기 CTA */}
                <div className="space-y-3 mt-6">
                    <button
                        onClick={handleShare}
                        className="w-full bg-gray-800 text-white font-bold py-3.5 px-4 rounded-xl flex items-center justify-center gap-2 border border-gray-700"
                    >
                        📤 결과 공유하기
                    </button>

                    <Link
                        href="/"
                        className="w-full bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold py-3.5 px-4 rounded-xl flex items-center justify-center gap-2 block text-center"
                    >
                        🔍 나도 분석해보기
                    </Link>
                </div>

                {/* 면책 조항 */}
                <p className="text-center text-xs text-gray-600 mt-4">
                    AI 분석 결과는 100% 정확하지 않으며, 참고용으로만 사용해주세요.
                </p>
            </div>
        </div>
    );
}
