import { TopBar, Eyebrow } from '@/components/case-ui';

/*
 * 개인정보처리방침 — AI 위장 여사친 판독기 (Ascentum)
 * 한국 개인정보보호법(PIPA) 구조 기반. 서비스의 실제 데이터 흐름을 반영.
 * ⚠️ 법률 문서: 표현/항목 변경은 사업자(사용자) 확인 후 진행할 것.
 */

const UPDATED = '2026년 7월 16일';

function H({ children }: { children: React.ReactNode }) {
    return <h2 className="mt-9 text-[15px] font-bold text-fg">{children}</h2>;
}

function Th({ children }: { children: React.ReactNode }) {
    return <th className="border border-line px-2.5 py-2 text-left font-semibold text-fg">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
    return <td className="border border-line px-2.5 py-2 align-top">{children}</td>;
}

export default function PrivacyPage() {
    return (
        <div className="min-h-dvh">
            <TopBar />
            <main className="mx-auto max-w-[680px] px-5 py-10">
                <Eyebrow>법적 고지</Eyebrow>
                <h1 className="mt-3 text-[26px] font-extrabold tracking-tight text-fg">개인정보처리방침</h1>
                <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">
                    Ascentum(이하 &ldquo;회사&rdquo;)은 &ldquo;AI 위장 여사친 판독기&rdquo;(이하 &ldquo;서비스&rdquo;)를 운영하며, 「개인정보 보호법」 등 관계
                    법령을 준수하고 정보주체의 개인정보를 보호하기 위해 다음과 같이 개인정보처리방침을 수립·공개합니다.
                </p>

                <div className="mt-4 text-[13px] leading-relaxed text-fg-dim [&_li]:mt-1 [&_ul]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-5">
                    <H>제1조 (개인정보의 처리 목적)</H>
                    <p className="mt-2">회사는 다음의 목적을 위하여 개인정보를 처리하며, 목적 이외의 용도로는 이용하지 않습니다.</p>
                    <ul>
                        <li>회원 가입 및 관리: 회원제 서비스 제공, 본인 식별·인증, 회원자격 유지·관리, 부정이용 방지, 고지·통지</li>
                        <li>서비스 제공: 이용자가 입력한 인스타그램 계정의 공개 정보에 대한 AI 분석 및 결과 리포트 제공, 콘텐츠 제공</li>
                        <li>유료 서비스 제공: 요금 결제, 구매 및 이용 내역 관리, 환불 처리</li>
                        <li>고객 문의 대응 및 분쟁 처리</li>
                        <li>서비스 개선·통계 분석, 신규 서비스 개발, 접속 빈도 분석</li>
                        <li>(선택) 이벤트·혜택 정보 안내 등 마케팅 (동의한 경우에 한함)</li>
                    </ul>

                    <H>제2조 (수집하는 개인정보의 항목 및 방법)</H>
                    <p className="mt-2">회사는 회원가입·서비스 이용 과정에서 아래 항목을 수집합니다.</p>
                    <div className="mt-3 overflow-x-auto">
                        <table className="w-full border-collapse text-[12px]">
                            <thead className="bg-ink-2">
                                <tr>
                                    <Th>구분</Th>
                                    <Th>수집 항목</Th>
                                    <Th>수집 방법</Th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <Td>소셜 로그인·회원가입 (필수)</Td>
                                    <Td>이름, 이메일 주소, 프로필 이미지·닉네임, 카카오계정(전화번호)</Td>
                                    <Td>카카오·구글 소셜 로그인 시 이용자 동의를 받아 연동</Td>
                                </tr>
                                <tr>
                                    <Td>소셜 로그인·회원가입 (선택)</Td>
                                    <Td>성별, 출생 연도</Td>
                                    <Td>카카오 소셜 로그인 시 이용자 동의를 받아 연동</Td>
                                </tr>
                                <tr>
                                    <Td>서비스 이용</Td>
                                    <Td>이용자가 입력한 분석 대상 인스타그램 계정 아이디 및 해당 계정의 공개 정보(공개 게시물·프로필 등)</Td>
                                    <Td>이용자의 직접 입력</Td>
                                </tr>
                                <tr>
                                    <Td>유료 결제</Td>
                                    <Td>결제 내역, 구매·이용 기록 (카드번호 등 결제수단 정보는 결제대행사가 처리하며 회사는 보관하지 않음)</Td>
                                    <Td>결제 과정에서 생성</Td>
                                </tr>
                                <tr>
                                    <Td>자동 수집</Td>
                                    <Td>접속 IP, 쿠키, 기기·브라우저 정보, 서비스 이용 기록·접속 로그</Td>
                                    <Td>서비스 이용 과정에서 자동 생성·수집</Td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="mt-2 text-[12px] text-fg-mute">
                        ※ 선택 항목에 동의하지 않아도 서비스의 본질적 기능은 이용할 수 있습니다. 분석 대상 인스타그램 계정의 정보는 &ldquo;공개된&rdquo; 정보에
                        한하며, 비공개 계정의 게시물은 수집·분석하지 않습니다.
                    </p>

                    <H>제3조 (개인정보의 보유 및 이용 기간)</H>
                    <p className="mt-2">
                        회사는 원칙적으로 개인정보 처리 목적이 달성되거나 회원 탈퇴 시 지체 없이 해당 개인정보를 파기합니다. 다만 관계 법령에 따라 보존이
                        필요한 경우 아래와 같이 보관합니다.
                    </p>
                    <ul>
                        <li>계약 또는 청약철회 등에 관한 기록: 5년 (전자상거래 등에서의 소비자보호에 관한 법률)</li>
                        <li>대금결제 및 재화 등의 공급에 관한 기록: 5년 (동법)</li>
                        <li>소비자의 불만 또는 분쟁처리에 관한 기록: 3년 (동법)</li>
                        <li>표시·광고에 관한 기록: 6개월 (동법)</li>
                        <li>접속에 관한 기록(로그인 기록 등): 3개월 (통신비밀보호법)</li>
                        <li>분석 대상 인스타그램 공개 데이터 및 중간 처리 데이터: 분석 완료 및 결과 제공 목적 달성 후 지체 없이 파기</li>
                    </ul>

                    <H>제4조 (개인정보 처리의 위탁)</H>
                    <p className="mt-2">회사는 원활한 서비스 제공을 위해 아래와 같이 개인정보 처리업무를 위탁하고 있습니다.</p>
                    <div className="mt-3 overflow-x-auto">
                        <table className="w-full border-collapse text-[12px]">
                            <thead className="bg-ink-2">
                                <tr>
                                    <Th>수탁자</Th>
                                    <Th>위탁 업무</Th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr><Td>Supabase Inc.</Td><Td>회원 인증, 데이터베이스 운영·보관</Td></tr>
                                <tr><Td>Vercel Inc.</Td><Td>서비스 호스팅·인프라 운영</Td></tr>
                                <tr><Td>Google LLC</Td><Td>AI 분석 처리(Gemini/Vertex AI), 비동기 작업 처리(Cloud Tasks), 소셜 로그인 인증</Td></tr>
                                <tr><Td>Kakao Corp.</Td><Td>카카오 소셜 로그인 인증</Td></tr>
                                <tr><Td>Apify Technologies</Td><Td>인스타그램 공개 정보 수집 처리</Td></tr>
                                <tr><Td>Resend, Inc.</Td><Td>이메일 발송</Td></tr>
                                <tr><Td>Amplitude, Inc.</Td><Td>서비스 이용 통계·분석</Td></tr>
                                <tr><Td>결제대행사(PG)</Td><Td>유료 서비스 결제 처리</Td></tr>
                            </tbody>
                        </table>
                    </div>

                    <H>제5조 (개인정보의 국외 이전)</H>
                    <p className="mt-2">
                        회사는 서비스 제공을 위해 아래와 같이 개인정보를 국외에 이전(위탁·보관)하고 있습니다. 정보주체는 국외 이전을 거부할 수 있으며, 거부 시
                        일부 서비스 이용이 제한될 수 있습니다.
                    </p>
                    <ul>
                        <li>이전받는 자: Supabase(미국), Vercel(미국), Google(미국), Apify(체코/미국 등), Resend(미국), Amplitude(미국) 및 각 사의 클라우드 리전</li>
                        <li>이전 항목: 제2조의 수집 항목 중 각 업무 수행에 필요한 정보</li>
                        <li>이전 일시·방법: 서비스 이용 시점에 네트워크를 통한 전송</li>
                        <li>이전 목적: 제1조의 처리 목적(인증·저장·AI 분석·호스팅·이메일·통계)</li>
                        <li>보유·이용 기간: 위탁 계약 종료 시 또는 처리 목적 달성 시까지</li>
                    </ul>

                    <H>제6조 (개인정보의 제3자 제공)</H>
                    <p className="mt-2">
                        회사는 정보주체의 개인정보를 제1조의 목적 범위 내에서만 처리하며, 정보주체의 동의, 법률의 특별한 규정 등 「개인정보 보호법」이
                        허용하는 경우 외에는 제3자에게 제공하지 않습니다.
                    </p>

                    <H>제7조 (정보주체와 법정대리인의 권리·의무 및 행사 방법)</H>
                    <p className="mt-2">정보주체는 언제든지 다음 권리를 행사할 수 있습니다.</p>
                    <ul>
                        <li>개인정보 열람·정정·삭제·처리정지 요구</li>
                        <li>개인정보 수집·이용·제공에 대한 동의 철회 및 회원 탈퇴</li>
                    </ul>
                    <p className="mt-2">
                        권리 행사는 서비스 내 기능 또는 개인정보 보호책임자에게 서면·이메일로 요청할 수 있으며, 회사는 지체 없이 조치합니다. 법정대리인이나
                        위임을 받은 자를 통해서도 행사할 수 있습니다.
                    </p>

                    <H>제8조 (개인정보의 파기 절차 및 방법)</H>
                    <ul>
                        <li>파기 절차: 목적 달성 후 별도 DB로 옮겨 내부 방침 및 관계 법령에 따라 일정 기간 보관 후 파기합니다.</li>
                        <li>파기 방법: 전자적 파일은 복구·재생이 불가능한 방법으로 영구 삭제하고, 출력물은 분쇄하거나 소각합니다.</li>
                    </ul>

                    <H>제9조 (개인정보의 안전성 확보조치)</H>
                    <ul>
                        <li>관리적 조치: 내부관리계획 수립·시행, 개인정보 취급자 최소화 및 접근권한 관리</li>
                        <li>기술적 조치: 접근통제, 비밀번호·중요정보의 암호화, 보안 통신(HTTPS), 접속기록 관리</li>
                        <li>물리적 조치: 클라우드 인프라 접근 통제</li>
                    </ul>

                    <H>제10조 (만 14세 미만 아동의 개인정보)</H>
                    <p className="mt-2">
                        본 서비스는 만 14세 이상의 이용자를 대상으로 하며, 만 14세 미만 아동의 회원가입을 받지 않습니다. 만 14세 미만 아동의 개인정보가 수집된
                        사실이 확인되는 경우 지체 없이 파기합니다.
                    </p>

                    <H>제11조 (쿠키 등 자동 수집 장치의 운영)</H>
                    <p className="mt-2">
                        회사는 로그인 유지, 이용 통계 분석 등을 위해 쿠키를 사용합니다. 이용자는 웹 브라우저 설정을 통해 쿠키 저장을 거부할 수 있으며, 이 경우
                        로그인 등 일부 서비스 이용에 제한이 있을 수 있습니다.
                    </p>

                    <H>제12조 (개인정보 보호책임자 및 문의처)</H>
                    <p className="mt-2">
                        개인정보 처리에 관한 문의, 불만 처리, 피해 구제 등은 아래로 연락해 주시기 바랍니다.
                    </p>
                    <ul>
                        <li>개인정보 보호책임자: Youngmin Park (대표)</li>
                        <li>상호: Ascentum · 사업자등록번호: 478-59-01063</li>
                        <li>이메일: contact@ascentum.co.kr</li>
                    </ul>
                    <p className="mt-2 text-[12px] text-fg-mute">
                        기타 개인정보 침해에 대한 신고·상담은 개인정보분쟁조정위원회(1833-6972), 개인정보침해신고센터(118), 대검찰청(1301),
                        경찰청 사이버수사국(182)에 문의할 수 있습니다.
                    </p>

                    <H>제13조 (개인정보처리방침의 변경)</H>
                    <p className="mt-2">
                        본 방침은 법령·서비스 변경에 따라 개정될 수 있으며, 변경 시 서비스 내 공지를 통해 고지합니다.
                    </p>

                    <p className="mt-8 border-t border-line pt-5 text-[12px] text-fg-mute">
                        공고일자: {UPDATED}
                        <br />시행일자: {UPDATED}
                    </p>
                </div>
            </main>
        </div>
    );
}
