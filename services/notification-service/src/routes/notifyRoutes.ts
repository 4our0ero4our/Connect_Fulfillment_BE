import { Router, Request, Response } from 'express';
import { dispatchNotification } from '../services/notificationService';
import { requireCFAdmin, requireInternalService } from '../middleware/auth';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Notification Service is running', service: 'notification-service' });
});

// This endpoint is used to send a notification to a user
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


// For CF Admins to manually trigger notifications
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
