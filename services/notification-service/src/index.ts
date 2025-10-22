
import express from 'express';
import notifyRoutes from './routes/notifyRoutes';
import { Request, Response } from 'express';
const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'notification-service' });
});

app.use('/', notifyRoutes);

app.listen(4005, () => console.log('notification-service listening on 4005'));