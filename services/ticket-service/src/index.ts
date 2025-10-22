
import express from 'express';
import ticketRoutes from './routes/ticketRoutes';
import { Request, Response } from 'express';

const app = express();
app.use(express.json());


app.use('/', ticketRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'ticket-service' });
});

app.listen(4003, () => console.log('ticket-service listening on 4003'));
