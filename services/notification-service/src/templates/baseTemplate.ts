const brand = {
  name: 'Connect Fulfillment',
  primary: '#1E3A8A',
  accent: '#3B82F6',
  background: '#F3F4F6',
  text: '#0F172A',
  logoUrl: (process.env.CF_BRAND_LOGO_URL || 'https://dummyimage.com/200x60/1e3a8a/ffffff&text=Connect+Fulfillment').trim(),
};

interface BaseTemplateOptions {
  title: string;
  preheader?: string;
  bodyHtml: string;
}

export const renderBaseTemplate = ({ title, preheader, bodyHtml }: BaseTemplateOptions) => {
  const safePreheader = preheader || 'Notification from Connect Fulfillment';
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    @media only screen and (max-width: 600px) {
      .container {
        width: 100% !important;
        padding: 16px !important;
      }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${brand.background};font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <span style="display:none;font-size:0;height:0;line-height:0;color:#fff;max-height:0;max-width:0;opacity:0;overflow:hidden;">${safePreheader}</span>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${brand.background};padding:32px 0;">
    <tr>
      <td align="center">
        <table class="container" width="600" cellpadding="0" cellspacing="0" role="presentation" style="background:#ffffff;border-radius:16px;padding:32px;box-shadow:0 10px 30px rgba(15,23,42,0.08);">
          <tr>
            <td style="text-align:center;padding-bottom:24px;">
              <img src="${brand.logoUrl}" alt="${brand.name} logo" style="max-width:220px;height:auto;margin-bottom:12px;" />
              <h1 style="margin:0;font-size:24px;color:${brand.text};">${title}</h1>
            </td>
          </tr>
          <tr>
            <td style="font-size:16px;line-height:1.6;color:${brand.text};">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding-top:32px;text-align:center;font-size:12px;color:#6B7280;">
              <p style="margin:0;">You are receiving this email because a workflow triggered a notification on ${brand.name}.</p>
              <p style="margin:8px 0 0 0;">&copy; ${new Date().getFullYear()} ${brand.name}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();
};

