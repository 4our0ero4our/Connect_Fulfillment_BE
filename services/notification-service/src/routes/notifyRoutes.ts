import { Router, Request, Response } from 'express';
import { dispatchNotification } from '../services/notificationService';
import { requireCFAdmin, requireInternalService } from '../middleware/auth';

const router = Router();

/**
 * Health check endpoint for the Notification Service.
 * Returns a simple status message to confirm the service is running.
 * 
 * @route GET /
 * @returns {Object} Service status message
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Notification Service is running', service: 'notification-service' });
});

/**
 * Send a notification email (Internal service only).
 * 
 * Allows internal services to dispatch email notifications programmatically.
 * Used by other microservices to send emails via the notification service.
 * Supports HTML/text content and file attachments.
 * 
 * @route POST /send
 * @access Internal (requires INTERNAL_SERVICE_TOKEN)
 * 
 * @param {string} req.body.to - Recipient email address
 * @param {string} req.body.subject - Email subject line
 * @param {string} [req.body.text] - Plain text email content
 * @param {string} [req.body.html] - HTML email content
 * @param {Array} [req.body.attachments] - Array of file attachments
 * @param {string} [req.body.category] - Notification category (default: 'external-trigger')
 * @param {Object} [req.body.meta] - Additional metadata for tracking
 * 
 * @returns {Object} 200 - Notification sent successfully
 * @returns {Object} 400 - Validation error (missing to or subject)
 */
router.post('/send', requireInternalService, async (req: Request, res: Response) => {
  try {
    const { to, subject, text, html, attachments, category, meta } = req.body || {};

    if (!to || !subject) {
      return res.status(400).json({
        message: 'Validation error',
        error: !to ? 'to is required' : !subject ? 'subject is required' : 'Invalid request body',
      });
    }

    await dispatchNotification({
      category: category || 'external-trigger',
      trigger: 'http:send',
      to,
      subject,
      text,
      html,
      attachments,
      meta,
    });

    return res.status(200).json({ message: 'Notification sent to ${to}' });
  } catch (error) {
    console.error('Notification /send error:', (error as any)?.message);
    return res.status(500).json({
      message: 'Failed to send notification',
      error: (error as any)?.message,
    });
  }
});


/**
 * Send a notification email manually (CF Admin only).
 * 
 * Allows CF Admins to manually send email notifications from the admin dashboard.
 * Useful for customer support, announcements, or manual communication. Tracks
 * the requesting admin in metadata for audit purposes.
 * 
 * @route POST /send-admin
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.body.to - Recipient email address
 * @param {string} req.body.subject - Email subject line
 * @param {string} [req.body.text] - Plain text email content (required if html not provided)
 * @param {string} [req.body.html] - HTML email content (required if text not provided)
 * @param {Array} [req.body.attachments] - Array of file attachments
 * 
 * @returns {Object} 200 - Admin notification dispatched successfully
 * @returns {Object} 400 - Validation error (missing required fields)
 */
router.post('/send-admin', requireCFAdmin, async (req: Request, res: Response) => {
  try {
    const { to, subject, text, html, attachments } = req.body || {};
    if (!to || !subject || (!text && !html)) {
      return res.status(400).json({
        message: 'Validation error',
        error: '"to", "subject" and either "text" or "html" are required',
      });
    }

    await dispatchNotification({
      category: 'manual-admin',
      trigger: 'http:send-admin',
      to,
      subject,
      text,
      html,
      attachments,
      meta: {
        requestedBy: res.locals.adminEmail,
      },
    });

    return res.status(200).json({ message: 'Admin notification dispatched' });
  } catch (error) {
    console.error('Notification /send-admin error:', (error as any)?.message);
    return res.status(500).json({
      message: 'Failed to send notification',
      error: (error as any)?.message,
    });
  }
});

export default router;
