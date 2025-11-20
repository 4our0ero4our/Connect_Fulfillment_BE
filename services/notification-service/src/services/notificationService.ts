import { Notification } from '../models/Notis';
import { sendEmail } from '../utils/emailClient';
import { renderEmailLayout } from '../templates/emailLayout';
import { generateTicketCard } from '../utils/qrCard';
import { htmlToText } from 'html-to-text';

export interface NotificationInput {
  category: string;
  trigger: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  subtitle?: string;
  intro?: string;
  footerNote?: string;
  preheader?: string;
  useLayout?: boolean;
  cta?: { label: string; url: string };
  attachments?: Array<{ filename: string; path?: string; content?: string | Buffer; contentType?: string; cid?: string }>;
  meta?: Record<string, unknown>;
}

const sentenceCase = (status: string) => status?.charAt(0).toUpperCase() + status?.slice(1);
const formatDateTime = (value?: string | number | Date) =>
  value ? new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const buildDetailsTable = (rows: Array<{ label: string; value: string }>) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0;">
    ${rows
      .map(
        row => `
      <tr>
        <td style="padding:8px 0;color:#6B7280;font-size:13px;width:30%;text-transform:uppercase;letter-spacing:0.05em;">${row.label}</td>
        <td style="padding:8px 0;color:#0F172A;font-size:16px;">${row.value}</td>
      </tr>`
      )
      .join('')}
  </table>`;

export const dispatchNotification = async (input: NotificationInput) => {
  const recipients = Array.isArray(input.to) ? input.to : [input.to];
  const contentHtml = input.html || '';
  const shouldWrap = input.useLayout ?? true;
  const wrappedHtml = shouldWrap
    ? renderEmailLayout({
        title: input.subject,
        subtitle: input.subtitle,
        intro: input.intro,
        body: contentHtml,
        cta: input.cta,
        footerNote: input.footerNote,
        preheader: input.preheader,
      })
    : contentHtml;
  const textVersion =
    input.text ||
    htmlToText(wrappedHtml, {
      selectors: [{ selector: 'img', format: 'skip' }],
      wordwrap: 120,
    });

  const notification = await Notification.create({
    category: input.category,
    trigger: input.trigger,
    channel: 'email',
    to: recipients,
    subject: input.subject,
    text: textVersion,
    html: wrappedHtml,
    attachments: input.attachments,
    meta: input.meta,
    status: 'queued',
  });

  try {
    await sendEmail({
      to: recipients,
      subject: input.subject,
      text: textVersion,
      html: wrappedHtml,
      attachments: input.attachments,
    });

    notification.status = 'sent';
    await notification.save();
    console.log(`✅ Notification sent (${input.category}) to ${recipients.join(', ')}`);
    return notification;
  } catch (error) {
    console.error('Failed to send notification:', (error as any)?.message);
    notification.status = 'failed';
    notification.errorMessage = (error as any)?.message;
    await notification.save();
    throw error;
  }
};

export const handleOrderStatusUpdated = async (event: any) => {
  if (!event?.customerInfo?.customerEmail) return;

  const friendlyStatus = sentenceCase(event.newStatus || '');
  const rows = [
    { label: 'Order Number', value: event.orderNumber || event.orderId || '—' },
    { label: 'Merchant', value: event.companyName || '—' },
    { label: 'Status', value: friendlyStatus },
    { label: 'Updated', value: formatDateTime(event.updatedAt || Date.now()) },
  ];

  await dispatchNotification({
    category: event.newStatus === 'cancelled' ? 'order-cancelled' : 'order-status',
    trigger: 'kafka:order_status_updated',
    to: event.customerInfo.customerEmail,
    subject: `Order ${event.orderNumber || event.orderId} is now ${friendlyStatus}`,
    preheader: `Your order just moved to ${friendlyStatus}`,
    intro: `Hi ${event.customerInfo.customerName || 'there'},`,
    html: `
      <p>Your order has been updated. Here are the latest details:</p>
      ${buildDetailsTable(rows)}
      <p style="margin-top:24px;">Thank you for shopping with Connect Fulfillment.</p>
    `,
    meta: event,
  });
};

export const handleTicketGenerated = async (event: any) => {
  if (!event?.customerInfo?.customerEmail) return;

  let attachments: NotificationInput['attachments'] = [];
  let ticketImgHtml = '';
  try {
    const card = await generateTicketCard({
      ticketId: event.ticketId,
      orderNumber: event.orderNumber || event.orderId,
      customerEmail: event.customerInfo.customerEmail,
      companyName: event.companyName || 'Connect Fulfillment Merchant',
      status: event.status || 'Packed',
      qrPayload: event.qrPayload || event.qrCode || event.ticketId,
    });
    attachments = [
      {
        filename: card.filename,
        content: card.buffer,
        contentType: 'image/png',
        cid: card.cid,
      },
    ];
    ticketImgHtml = `<div style="text-align:center;margin-top:24px;">
      <img src="cid:${card.cid}" alt="Ticket QR" style="max-width:360px;width:100%;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,0.25);" />
      <p style="color:#6B7280;font-size:13px;margin-top:8px;">Download or screenshot this pass to present at pickup.</p>
    </div>`;
  } catch (error) {
    console.error('Failed to generate ticket card:', (error as any)?.message);
  }

  const rows = [
    { label: 'Order Number', value: event.orderNumber || event.orderId || '—' },
    { label: 'Ticket ID', value: event.ticketId || '—' },
    { label: 'Merchant', value: event.companyName || '—' },
  ];

  await dispatchNotification({
    category: 'ticket-generated',
    trigger: 'kafka:ticket_generated',
    to: event.customerInfo.customerEmail,
    subject: `Your ticket for order ${event.orderNumber || event.orderId}`,
    preheader: 'Your pickup pass is ready',
    intro: `Hi ${event.customerInfo.customerName || 'there'},`,
    html: `
      <p>Your pickup pass is ready. Please arrive with this QR code and a valid ID.</p>
      ${buildDetailsTable(rows)}
      ${ticketImgHtml}
    `,
    attachments,
    meta: {
      orderId: event.orderId,
      ticketId: event.ticketId,
      companyId: event.companyId,
    },
  });
};

export const handleTicketValidated = async (event: any) => {
  const email = event?.customerEmail || event?.customerInfo?.customerEmail;
  if (!email) return;

  await dispatchNotification({
    category: 'order-collected',
    trigger: 'kafka:ticket_validated',
    to: email,
    subject: `Order ${event.orderNumber || event.orderId} has been collected`,
    preheader: 'Pickup confirmed',
    html: `
      <p>Your order <strong>${event.orderNumber || event.orderId}</strong> was just marked as collected.</p>
      <p>If you did not authorize this, contact support immediately.</p>
    `,
    meta: event,
  });
};

export const handleAdminPasswordChanged = async (event: any) => {
  if (!event?.email) return;

  await dispatchNotification({
    category: 'security',
    trigger: 'kafka:admin_password_changed',
    to: event.email,
    subject: 'Your Connect Fulfillment password was changed',
    preheader: 'Password update confirmation',
    intro: `Hello ${event.name || ''},`,
    html: `
      <p>We noticed your password was changed just now. If this wasn’t you, reset it immediately or contact support.</p>
    `,
    meta: event,
  });
};

export const handleAdminAdded = async (event: any) => {
  if (!event?.email) return;

  const inviteLink = event.inviteUrl || process.env.COMPANY_PORTAL_URL || '#';

  await dispatchNotification({
    category: 'admin-invite',
    trigger: event.trigger || 'kafka:admin_added',
    to: event.email,
    subject: 'You have been added as an admin',
    preheader: 'Complete your setup',
    intro: `Hello ${event.name || ''},`,
    html: `
      <p>You have been added as an admin for ${event.companyName || 'Connect Fulfillment'}.</p>
    `,
    cta: { label: 'Finish setup', url: inviteLink },
    meta: event,
  });
};

export const handleOrderDeleted = async (event: any) => {
  if (!event?.customerInfo?.customerEmail && !event?.companyEmail) return;
  const rows = [
    { label: 'Order Number', value: event.orderNumber || event.orderId || '—' },
    { label: 'Merchant', value: event.companyName || '—' },
    { label: 'Deleted At', value: formatDateTime(event.deletedAt) },
  ];
  const html = `
    <p>The order below was deleted.</p>
    ${buildDetailsTable(rows)}
  `;

  if (event.customerInfo?.customerEmail) {
    await dispatchNotification({
      category: 'order-deleted',
      trigger: 'kafka:order_deleted',
      to: event.customerInfo.customerEmail,
      subject: `Order ${event.orderNumber || event.orderId} was cancelled`,
      preheader: 'Order removed',
      html: `<p>Hi ${event.customerInfo.customerName || 'there'},</p>${html}`,
      meta: event,
    });
  }

  if (event.companyEmail) {
    await dispatchNotification({
      category: 'order-deleted-merchant',
      trigger: 'kafka:order_deleted',
      to: event.companyEmail,
      subject: `Order ${event.orderNumber || event.orderId} was deleted`,
      preheader: 'Order removed',
      html,
      meta: event,
    });
  }
};

export const handleCompanyVerified = async (event: any) => {
  if (!event?.companyEmail) return;
  const link = event.onboardingLink || (process.env.COMPANY_PORTAL_URL || '#');
  await dispatchNotification({
    category: 'company-verified',
    trigger: 'kafka:company_verified',
    to: event.companyEmail,
    subject: 'Your Connect Fulfillment account is live',
    preheader: 'Access your API key securely',
    intro: `Congratulations, ${event.companyName}! Your onboarding has been approved.`,
    html: `
      <p>Use the secure link below (expires in 24 hours) to access your API key. This link works once, so store the key in your password manager.</p>
      ${buildDetailsTable([
        { label: 'Company', value: event.companyName },
        { label: 'API Key (masked)', value: event.apiKeyMasked || 'Hidden' },
      ])}
    `,
    cta: { label: 'Retrieve API Key', url: link },
    meta: event,
  });
};

export const handleCompanyApiKeyStatusChanged = async (event: any) => {
  if (!event?.companyEmail) return;
  await dispatchNotification({
    category: 'company-api-key',
    trigger: 'kafka:company_api_key_status_changed',
    to: event.companyEmail,
    subject: `Your API key is now ${event.status}`,
    preheader: 'API key status update',
    html: `
      <p>Your API key has been ${event.status === 'active' ? 'activated' : 'deactivated'}.</p>
      ${buildDetailsTable([
        { label: 'Company', value: event.companyName },
        { label: 'Status', value: sentenceCase(event.status) },
        { label: 'Changed By', value: event.changerEmail || 'System' },
      ])}
    `,
    meta: event,
  });
};

export const handleCompanyStatusChanged = async (event: any) => {
  if (!event?.companyEmail) return;
  await dispatchNotification({
    category: 'company-status',
    trigger: 'kafka:company_status_changed',
    to: event.companyEmail,
    subject: `Your merchant account is now ${event.isActive ? 'active' : 'inactive'}`,
    preheader: 'Merchant status updated',
    html: `
      <p>Your merchant account has been ${event.isActive ? 'reactivated' : 'deactivated'}.</p>
      ${buildDetailsTable([
        { label: 'Company', value: event.companyName },
        { label: 'Status', value: event.isActive ? 'Active' : 'Inactive' },
        { label: 'Reason', value: event.reason || '—' },
      ])}
      <p>If you need help, reply to this email.</p>
    `,
    meta: event,
  });
};

export const handleCompanyAdminRemoved = async (event: any) => {
  if (!event?.adminEmail) return;
  await dispatchNotification({
    category: 'company-admin-removed',
    trigger: 'kafka:company_admin_removed',
    to: event.adminEmail,
    subject: `Access removed for ${event.companyName}`,
    preheader: 'Admin access revoked',
    html: `
      <p>Your admin access for ${event.companyName} has been revoked.</p>
      ${buildDetailsTable([
        { label: 'Company', value: event.companyName },
        { label: 'Removed By', value: event.removedBy?.adminEmail || 'Platform Administrator' },
      ])}
      <p>Contact the Connect Fulfillment team if you believe this is a mistake.</p>
    `,
    meta: event,
  });
};

