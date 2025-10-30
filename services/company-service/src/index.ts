import express from 'express';
import companyRoute from './routes/companyRoute';
import { Request, Response } from 'express';

const app = express();

app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'company-service' });
});

app.use('/', companyRoute);

app.listen(4004, () => console.log('company-service listening on 4004'));