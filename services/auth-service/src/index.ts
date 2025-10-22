
import express from 'express';
import authRoutes from './routes/authRoutes';
import { Request, Response } from 'express';
const app = express();

app.use(express.json());

app.use('/', authRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

app.listen(4001, () => console.log('auth-service listening on 4001'));
 