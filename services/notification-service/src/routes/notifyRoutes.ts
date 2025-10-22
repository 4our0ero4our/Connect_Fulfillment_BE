import { Router } from 'express';
import { Request, Response } from 'express';
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Notification Service is running', service: 'notification-service' });
});


router.post('/send', async (_req: Request, res: Response) => {
  // send email webhook
  res.status(200).json({ message: 'email sent (stub)' });
});

export default router;
