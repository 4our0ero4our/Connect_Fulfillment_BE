import { Router } from 'express';
import { Request, Response } from 'express';
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Auth Service is running', service: 'auth-service' });
});

router.post('/register', async (_req : Request, res : Response) => {
  // Registration logic goes here
  res.status(201).json({ message: 'registered (stub)' });
});

router.post('/login', async (_req : Request, res : Response) => {
  // Login logic goes here
  res.status(200).json({ token: 'JWT_TOKEN_HERE' });
});

export default router;
 