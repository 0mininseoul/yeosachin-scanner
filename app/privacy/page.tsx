import { TopBar, Eyebrow } from '@/components/case-ui';

/*
 * 개인정보처리방침 — AI 위장 여사친 판독기 (Ascentum)
 * 한국 개인정보보호법(PIPA) 구조 기반. 서비스의 실제 데이터 흐름을 반영.
 * ⚠️ 법률 문서: 표현/항목 변경은 사업자(사용자) 확인 후 진행할 것.
 */

const UPDATED = '2026년 7월 19일';

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
                        <li>만 14세 이상 이용 연령 확인 및 연령대·성별 기반 맞춤 서비스 제공</li>
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
                                    <Td>이름, 이메일 주소, 프로필 이미지·닉네임, 카카오계정(전화번호), 성별, 출생 연도</Td>
                                    <Td>카카오·구글 소셜 로그인 시 이용자 동의를 받아 연동</Td>
                                </tr>
                                <tr>
                                    <Td>서비스 이용</Td>
                                    <Td>이용자가 입력한 분석 대상 인스타그램 계정 아이디 및 해당 계정의 공개 정보(공개 게시물·프로필 등)</Td>
                                    <Td>이용자의 직접 입력</Td>
                                </tr>
                                <tr>
                                    <Td>유료 결제</Td>
                                    <Td>결제 내역, 구매·이용 기록, 그로블 구매자 주문자명·이메일·전화번호(서명된 결제 웹훅 처리 중 일시적 처리)</Td>
                                    <Td>서명을 검증한 그로블 결제 이벤트 수신 시</Td>
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
                        ※ 위 필수 항목은 회원가입 및 서비스 제공에 반드시 필요한 정보로, 동의를 거부하실 경우 회원가입 및 서비스 이용이 제한됩니다. 분석 대상
                        인스타그램 계정의 정보는 &ldquo;공개된&rdquo; 정보에 한하며, 비공개 계정의 게시물은 수집·분석하지 않습니다.
                    </p>
                    <p className="mt-2 text-[12px] text-fg-mute">
                        그로블 구매자 주문자명·이메일·전화번호는 서명된 웹훅 처리 트랜잭션에서 결제 매칭, 이행·결과 제공, 분쟁·환불 지원을 위해 일시적으로 처리합니다.
                        이 항목들은 서비스 DB에 영속적으로 저장하지 않고 고객용 API, Amplitude 및 Axiom에 전송하지 않습니다. 서비스 로그인 이메일과 그로블 이메일은
                        일치하지 않아도 전화번호로 매칭할 수 있습니다. 카드 등 결제수단 정보와 원문 웹훅 payload도 회사가 보관하지 않습니다.
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
                        <li>결제 상품·금액·상태·주문 연결 기록: 대금결제 및 분쟁 처리에 적용되는 위 법정 보존기간(그로블 구매자 연락처는 포함하지 않음)</li>
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
                                <tr><Td>Apify Technologies s.r.o.</Td><Td>인스타그램 공개 정보 수집 처리</Td></tr>
                                <tr><Td>Plus Five Five, Inc. (Resend)</Td><Td>이메일 발송</Td></tr>
                                <tr><Td>Amplitude, Inc.</Td><Td>서비스 이용 통계·분석</Td></tr>
                                <tr><Td>Axiom, Inc.</Td><Td>서버 운영 로그의 수집·보관 및 장애 탐지·진단</Td></tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="mt-2 text-[12px] text-fg-mute">
                        리에종(그로블)은 통신판매중개자이며, 그로블 결제창에서 고지되는 외부 전자지급결제대행(PG) 사업자와 함께 위 수탁자 표에 포함되지 않습니다. 구매자는 그로블 결제창에서 각
                        사업자에게 정보를 직접 제공하며 각 사업자의 약관·개인정보 처리방침이 적용됩니다. 회사는 서명이 검증된 제한된 결제 이벤트만 수신합니다.
                    </p>
                    <p className="mt-2 text-[12px] text-fg-mute">
                        Axiom 운영 로그에는 장애 대응·진단에 필요한 인스타그램 계정 아이디가 포함될 수 있습니다. 구매자 이름·이메일·전화번호 등 연락처, 댓글, 소개글(bio),
                        캡션, 프로필·이미지·미디어 URL, OAuth·서비스 제공자 토큰, 쿠키, 서명, 요청·응답·외부 API 원문, AI 프롬프트·근거·총평 및 자격증명은 운영 로그에서
                        제외합니다. 그로블 구매자 연락처는 DB에 영속 저장하지 않고, 고객용 API 응답, Amplitude 및 Axiom에 전송하지 않습니다.
                    </p>
                    <p className="mt-2 text-[12px] text-fg-mute">
                        Amplitude는 허용된 서비스 이용 통계 이벤트와 속성만 처리하며, 인스타그램 계정 아이디, 이메일·전화번호, 프로필·소셜 콘텐츠 및 URL은 전송하지
                        않습니다. Amplitude Session Replay는 비활성화되어 화면 재생 데이터를 수집하지 않습니다.
                    </p>

                    <H>제5조 (개인정보의 국외 이전 및 해외 사업자 처리)</H>
                    <p className="mt-2">
                        해외 사업자를 이용하더라도 주 저장·런타임이 국내인 경우와 실제 국외 전송을 구분해 표시합니다. 국외 처리를 거부하려면 서비스 이용 전
                        개인정보 보호책임자에게 요청할 수 있으며, 필수 제공자의 처리를 거부하면 해당 기능 또는 서비스 제공이 불가할 수 있습니다.
                    </p>
                    <div className="mt-3 overflow-x-auto">
                        <table className="min-w-[1180px] border-collapse text-[11px]">
                            <thead className="bg-ink-2">
                                <tr>
                                    <Th>이전받는 자</Th><Th>국가·리전</Th><Th>이전 항목</Th><Th>일시·방법</Th>
                                    <Th>목적</Th><Th>보유·이용 기간</Th><Th>거부 방법·영향</Th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <Td>Supabase Inc.</Td><Td>주 저장·처리: 대한민국 서울(ap-northeast-2)</Td>
                                    <Td>회원·주문·분석 데이터</Td><Td>서비스 이용 중 암호화 네트워크 전송</Td>
                                    <Td>인증·DB 저장</Td><Td>회원 탈퇴·목적 달성 시까지, 법정 보존 예외</Td>
                                    <Td>처리정지 요청 가능, 거부 시 회원제 서비스 이용 불가</Td>
                                </tr>
                                <tr>
                                    <Td>Vercel Inc.</Td><Td>주 런타임: 대한민국 서울(icn1), CDN 엣지는 요청 경로에 따라 달라짐</Td>
                                    <Td>IP·기기/브라우저 정보, HTTP 요청·응답 메타데이터</Td><Td>사이트 접속 시 암호화 네트워크 전송</Td>
                                    <Td>호스팅·보안·요청 처리</Td><Td>프로젝트·공급자 로그 설정 및 계약 기간</Td>
                                    <Td>접속 전 처리정지 요청 가능, 거부 시 웹 서비스 이용 불가</Td>
                                </tr>
                                <tr>
                                    <Td>Google LLC</Td><Td>global endpoint(특정 처리 위치를 보장하지 않음, 국외 처리 가능)</Td>
                                    <Td>공개 프로필·피드 이미지·bio·캡션, AI 입력·출력, 비동기 작업 메타데이터, Google 로그인 정보</Td>
                                    <Td>AI 분석·작업 실행·로그인 시 암호화 전송</Td><Td>Gemini/Vertex AI 분석, Cloud Tasks, 소셜 인증</Td>
                                    <Td>회사 저장본은 목적 달성 후 파기, 공급자 처리는 계약·프로젝트 설정 기간</Td>
                                    <Td>AI 분석 전 요청 가능, 거부 시 판독·Google 로그인 기능 제한</Td>
                                </tr>
                                <tr>
                                    <Td>Apify Technologies s.r.o.</Td><Td>체코 및 공급자·서브처리자가 운영하는 미국 등 국가</Td>
                                    <Td>대상·공개 인스타그램 아이디와 공개 프로필·게시물 정보</Td><Td>수집 작업 시 암호화 전송</Td>
                                    <Td>공개 인스타그램 정보 수집</Td><Td>결과 제공 목적 달성 후 파기, 공급자 계약·법령상 필요 기간 예외</Td>
                                    <Td>수집 전 요청 가능, 거부 시 외부 수집이 필요한 판독 불가</Td>
                                </tr>
                                <tr>
                                    <Td>Plus Five Five, Inc. (Resend)</Td><Td>미국</Td><Td>수신 이메일, 메시지 본문·발송 메타데이터</Td>
                                    <Td>결과·알림 이메일 발송 시 암호화 전송</Td><Td>트랜잭션 이메일 발송</Td>
                                    <Td>계약 기간 및 계정 종료 후 90일 이내 삭제(Resend DPA 기준)</Td><Td>발송 전 요청 가능, 거부 시 이메일 알림 제한</Td>
                                </tr>
                                <tr>
                                    <Td>Amplitude, Inc.</Td><Td>미국(US endpoint)</Td><Td>가명 Supabase UUID, 이용 이벤트·플랜·구간화된 수치</Td>
                                    <Td>서비스 이용 이벤트 발생 시 암호화 전송</Td><Td>제품 이용 통계·전환 분석</Td>
                                    <Td>Amplitude 프로젝트 보관 설정·계약 기간 및 삭제 요청 시까지</Td><Td>브라우저 차단·처리정지 요청 가능, 핵심 판독은 가능하나 통계에서 제외</Td>
                                </tr>
                                <tr>
                                    <Td>Axiom, Inc.</Td><Td>미국 US East 1</Td><Td>운영 이벤트, 내부 UUID, 오류·성능 수치, 장애 진단용 인스타그램 계정 아이디</Td>
                                    <Td>운영 로그 생성 시 암호화 전송</Td><Td>장애 탐지·진단·운영 보안</Td><Td>30일</Td>
                                    <Td>처리정지 요청 가능, 거부 시 장애 진단·안정적 서비스 제공 제한</Td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p className="mt-2 text-[11px] text-fg-mute">
                        리전 근거: <a href="https://supabase.com/docs/guides/platform/regions" target="_blank" rel="noreferrer">Supabase regions</a>,{' '}
                        <a href="https://vercel.com/docs/regions" target="_blank" rel="noreferrer">Vercel regions</a>,{' '}
                        <a href="https://cloud.google.com/blog/products/ai-machine-learning/global-endpoint-for-claude-models-generally-available-on-vertex-ai" target="_blank" rel="noreferrer">Google global endpoint</a>,{' '}
                        <a href="https://axiom.co/docs/reference/edge-deployments" target="_blank" rel="noreferrer">Axiom edge deployments</a>.
                    </p>

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
