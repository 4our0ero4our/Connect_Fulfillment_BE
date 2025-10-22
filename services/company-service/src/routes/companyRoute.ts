import { Router } from 'express';
import { Request, Response } from 'express';
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Company Service is running', service: 'company-service' });
});

router.get('/verify/:apikey', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Company API key is valid', service: 'company-service' });
});

export default router;