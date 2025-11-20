const LOGO_URL =
  process.env.CF_BRAND_LOGO_URL ||
  'https://dummyimage.com/200x60/1e3a8a/ffffff&text=Connect+Fulfillment';

const BRAND_PRIMARY = '#1e3a8a';
const BRAND_ACCENT = '#3b82f6';

export interface EmailLayoutParams {
  title: string;
  subtitle?: string;
  intro?: string;
  body: string; // preformatted HTML (already escaped)
  cta?: { label: string; url: string };
  footerNote?: string;
  preheader?: string;
}

export const renderEmailLayout = ({
  title,
  subtitle,
  intro,
  body,
  cta,
  footerNote,
  preheader,
}: EmailLayoutParams) => {
  const buttonHtml = cta
    ? `<a href="${cta.url}" style="display:inline-block;background:${BRAND_ACCENT};color:#ffffff;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none;margin-top:14px">${cta.label}</a>`
    : '';

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="X-UA-Compatible" content="IE=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${title}</title>
    </head>
    <body style="margin:0;padding:0;background:#f1f4f9;font-family: 'Segoe UI', Arial, sans-serif;">
      <span style="display:none!important;color:transparent;height:0;max-height:0;opacity:0;overflow:hidden;visibility:hidden;width:0;">
        ${preheader || ''}
      </span>
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
          <td align="center" style="padding:32px 16px;">
            <table width="640" cellpadding="0" cellspacing="0" role="presentation" style="background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 25px 60px rgba(15,23,42,0.15);">
              <tr>
                <td style="background:${BRAND_PRIMARY};padding:32px;">
                  <img src="${LOGO_URL}" alt="Connect Fulfillment" style="max-width:220px;display:block;margin:0 auto 18px auto;" />
                  <h1 style="color:#ffffff;font-size:26px;font-weight:700;margin:0;text-align:center;">${title}</h1>
                  ${
                    subtitle
                      ? `<p style="color:#c7d2fe;font-size:16px;margin:6px 0 0 0;text-align:center;">${subtitle}</p>`
                      : ''
                  }
                </td>
              </tr>
              <tr>
                <td style="padding:32px;">
                  ${
                    intro
                      ? `<p style="font-size:16px;color:#0f172a;margin:0 0 18px 0;">${intro}</p>`
                      : ''
                  }
                  <div style="font-size:15px;line-height:1.6;color:#1e293b;">
                    ${body}
                  </div>
                  ${buttonHtml}
                </td>
              </tr>
              <tr>
                <td style="padding:24px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;color:#64748b;font-size:13px;">
                  ${
                    footerNote
                      ? `<p style="margin:0 0 8px 0;">${footerNote}</p>`
                      : ''
                  }
                  <p style="margin:0;">&copy; ${new Date().getFullYear()} Connect Fulfillment. All rights reserved.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;
};

