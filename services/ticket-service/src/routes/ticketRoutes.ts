
import { Router } from 'express';
import { Request, Response } from 'express';
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Ticket Service is running', service: 'ticket-service' });
});

router.post('/validate', async (_req: Request, res: Response) => {
  // validate ticket (check redis/cache then mongo)
  res.status(200).json({ valid: true, message: 'ticket validated (stub)' });
});

export default router;
