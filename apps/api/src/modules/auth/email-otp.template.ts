// Branded Arabic RTL email templates for OTP messages (password reset + email
// verification). Table-based with inline CSS so Gmail/Outlook render it well.
// No links: the only action is copying the code, so nothing needs trust.

export type OtpEmailVariant = "PASSWORD_RESET" | "EMAIL_VERIFY";

const BRAND_BLUE = "#2563eb";
const BRAND_BLUE_DARK = "#1d4ed8";
const INK = "#0f172a";
const BODY = "#334155";
const MUTED = "#64748b";
const FAINT = "#94a3b8";
const PAGE_BG = "#eef2f9";
const CODE_BG = "#eff6ff";

// The logo rides on the app's own public URL; an env var can override it
// (e.g. when a proper domain lands). The layout still reads fine when the
// image is blocked, since the brand name is plain text next to it.
const DEFAULT_LOGO_URL = "https://tezkar.up.railway.app/tezkar-logo.png";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildOtpEmail(
  variant: OtpEmailVariant,
  code: string,
  ttlMinutes: number
): { subject: string; html: string; text: string } {
  const logoUrl = process.env.TEZKAR_EMAIL_LOGO_URL ?? DEFAULT_LOGO_URL;
  const copy =
    variant === "EMAIL_VERIFY"
      ? {
          subject: "كود تأكيد البريد الإلكتروني — تذكار",
          title: "تأكيد البريد الإلكتروني",
          intro: "وصلنا طلب لإضافة هذا البريد إلى حسابك في تذكار. استخدم الكود التالي لإتمام التأكيد:",
          ignore: "لو لم تطلب ذلك، تجاهل هذه الرسالة ولن يتغير أي شيء في حسابك."
        }
      : {
          subject: "كود إعادة تعيين كلمة المرور — تذكار",
          title: "إعادة تعيين كلمة المرور",
          intro: "وصلنا طلب لإعادة تعيين كلمة المرور لحسابك في تذكار. استخدم الكود التالي لإتمام العملية:",
          ignore: "لو لم تطلب ذلك، تجاهل هذه الرسالة وستبقى كلمة مرورك كما هي دون أي تغيير."
        };
  const expiry = `الكود صالح لمدة ${ttlMinutes} دقائق ويُستخدم مرة واحدة فقط.`;

  const text = [
    `تذكار — ${copy.title}`,
    "",
    copy.intro,
    "",
    `كود التحقق: ${code}`,
    "",
    expiry,
    copy.ignore,
    "",
    "رسالة آلية من نظام تذكار، برجاء عدم الرد عليها."
  ].join("\n");

  const html = `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${PAGE_BG};">
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="${PAGE_BG}" style="background-color:${PAGE_BG};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;">
  <tr>
    <td style="padding:22px 28px 18px;border-bottom:1px solid #eef2f7;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding-left:12px;"><img src="${esc(logoUrl)}" width="52" height="52" alt="تذكار" style="display:block;border:0;border-radius:12px;"></td>
          <td>
            <div style="font-family:Tahoma,Arial,sans-serif;font-size:20px;font-weight:bold;color:${INK};">تذكار</div>
            <div style="font-family:Tahoma,Arial,sans-serif;font-size:12px;color:${MUTED};padding-top:2px;">نظام إدارة الإنتاج</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:26px 28px 4px;">
      <div style="font-family:Tahoma,Arial,sans-serif;font-size:22px;font-weight:bold;color:${INK};">${esc(copy.title)}</div>
      <div style="font-family:Tahoma,Arial,sans-serif;font-size:14px;line-height:24px;color:${BODY};padding-top:10px;">${esc(copy.intro)}</div>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:22px 28px 6px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center" dir="ltr" style="background-color:${CODE_BG};border:2px solid ${BRAND_BLUE};border-radius:14px;padding:14px 30px;font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:bold;letter-spacing:10px;color:${BRAND_BLUE_DARK};">${esc(code)}</td>
        </tr>
      </table>
      <div style="font-family:Tahoma,Arial,sans-serif;font-size:12px;color:${MUTED};padding-top:12px;">${esc(expiry)}</div>
    </td>
  </tr>
  <tr>
    <td style="padding:12px 28px 26px;">
      <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
        <tr>
          <td style="background-color:#f8fafc;border-radius:10px;padding:12px 16px;font-family:Tahoma,Arial,sans-serif;font-size:12px;line-height:20px;color:${MUTED};">${esc(copy.ignore)}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
<div style="font-family:Tahoma,Arial,sans-serif;font-size:11px;color:${FAINT};padding-top:14px;">رسالة آلية من نظام تذكار، برجاء عدم الرد عليها.</div>
</td></tr>
</table>
</body>
</html>`;

  return { subject: copy.subject, html, text };
}
