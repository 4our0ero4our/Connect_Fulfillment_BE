
import { Router } from 'express';
import { Request, Response } from 'express';
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Order Service is running', service: 'order-service' });
});

router.post('/', async (_req: Request, res: Response) => {
  // create order and produce to kafka
  res.status(201).json({ message: 'order created (stub)' });
});

router.get('/orderbyID/:id', async (req: Request, res: Response) => {
  // get order from database
  res.status(200).json({ orderId: req.params.id, status: 'PENDING', message: 'order retrieved (stub)' });
});

export default router;
