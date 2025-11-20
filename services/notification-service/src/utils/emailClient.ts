import nodemailer from 'nodemailer';

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const defaultFrom = process.env.NOTIFICATION_FROM || 'no-reply@connect-fulfillment.com';

let transporter: nodemailer.Transporter | null = null;

const initTransporter = () => {
  if (transporter || !smtpHost) return;
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: smtpUser
      ? {
          user: smtpUser,
          pass: smtpPass,
        }
      : undefined,
  });
};

export interface EmailAttachment {
  filename: string;
  path?: string;
  cid?: string;
  content?: string | Buffer;
  contentType?: string;
}

export interface EmailPayload {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
}

export const sendEmail = async (payload: EmailPayload) => {
  initTransporter();

  if (!transporter) {
    console.log('📬 Email disabled (no SMTP config). Logging payload instead.');
    console.log(JSON.stringify(payload, null, 2));
    return { accepted: Array.isArray(payload.to) ? payload.to : [payload.to] };
  }

  const info = await transporter.sendMail({
    from: defaultFrom,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    attachments: payload.attachments,
  });

  return info;
};

