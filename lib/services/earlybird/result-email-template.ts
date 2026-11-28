const htmlTemplate = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>@{{targetAccount}}의 결과가 준비됐어요</title>
</head>
<body style="margin:0;padding:0;background:#f4f1f1;color:#201b1c;font-family:'Apple SD Gothic Neo','Malgun Gothic',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f1f1;">
    <tr>
      <td align="center" style="padding:36px 12px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;background:#fff;border:1px solid #e7dddd;border-radius:18px;">
          <tr>
            <td bgcolor="#0c0a0b" style="padding:28px 24px 30px;border-top:4px solid #e4132a;border-radius:17px 17px 0 0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td valign="middle" style="padding-right:12px;">
                    <p style="margin:0;color:#f8ecef;font-size:17px;font-weight:bold;line-height:1.4;word-break:keep-all;">위장여사친판독기</p>
                  </td>
                  <td align="right" valign="middle" width="52">
                    <img src="https://yeosachin.com/icon-192.png" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border:0;border-radius:8px;">
                  </td>
                </tr>
              </table>
              <h1 style="margin:24px 0 0;color:#fff;font-size:30px;line-height:1.42;letter-spacing:-.7px;word-break:keep-all;">주문하신 <span style="color:#ff7382;overflow-wrap:anywhere;word-break:break-word;">@{{targetAccount}}</span>의 판독결과가 준비됐어요</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 24px;">
              <p style="margin:0 0 18px;color:#484041;font-size:16px;line-height:1.7;word-break:keep-all;">안녕하세요, 위장여사친판독기입니다. 결과 페이지에서 판독 요약과 후보별 결과를 확인하실 수 있어요.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td bgcolor="#b71932" align="center" style="border-radius:10px;">
                    <a href="{{resultUrl}}" style="display:block;padding:15px 18px;border:1px solid #b71932;border-radius:10px;color:#fff;font-size:17px;font-weight:bold;line-height:1.35;text-decoration:none;">판독 결과 보기</a>
                  </td>
                </tr>
              </table>
              <p style="margin:11px 0 25px;color:#595051;font-size:14px;line-height:1.65;word-break:keep-all;">주문할 때 사용한 계정으로 로그인하면 결과를 확인하실 수 있어요.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#faf6f6;border:1px solid #eee3e4;border-radius:12px;">
                <tr>
                  <td style="padding:17px 16px 13px;">
                    <p style="margin:0 0 4px;color:#251d1f;font-size:15px;line-height:1.4;font-weight:bold;">종합 판독 요약</p>
                    <p style="margin:0;color:#584d4f;font-size:14px;line-height:1.65;word-break:keep-all;">이번 분석에서 확인한 내용을 한눈에 볼 수 있어요.</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:13px 16px 17px;border-top:1px solid #eee3e4;">
                    <p style="margin:0 0 4px;color:#251d1f;font-size:15px;line-height:1.4;font-weight:bold;">후보별 판독 결과</p>
                    <p style="margin:0;color:#584d4f;font-size:14px;line-height:1.65;word-break:keep-all;">판독된 후보의 위협 등급 순위와 확인 가능한 근거를 볼 수 있어요.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td bgcolor="#fdfafa" style="padding:20px 24px 23px;border-top:1px solid #eee3e4;border-radius:0 0 17px 17px;">
              <p style="margin:0 0 8px;color:#514749;font-size:14px;line-height:1.65;word-break:keep-all;">결과가 열리지 않거나 궁금한 점이 있으시면 이 메일에 답장해 주세요.</p>
              <p style="margin:0;color:#34292b;font-size:14px;line-height:1.65;font-weight:bold;">위장여사친판독기 드림</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

export const PAID_RESULT_EMAIL_REPLY_TO = 'contact@ascentum.co.kr';

export function renderPaidResultEmail(target: string, requestId: string) {
    const resultUrl = `https://yeosachin.com/result/${requestId}`;
    return {
        subject: `@${target}의 결과가 준비됐어요`,
        html: htmlTemplate.replaceAll('{{targetAccount}}', target).replace('{{resultUrl}}', resultUrl),
        text: [
            `주문하신 @${target}의 판독결과가 준비됐어요`,
            '결과 페이지에서 판독 요약과 후보별 결과를 확인하실 수 있어요.',
            `판독 결과 보기 · ${resultUrl}`,
            '주문할 때 사용한 계정으로 로그인하면 결과를 확인하실 수 있어요.',
            '궁금한 점이 있으시면 이 메일에 답장해 주세요.',
            '위장여사친판독기 드림',
        ].join('\n\n'),
    };
}
