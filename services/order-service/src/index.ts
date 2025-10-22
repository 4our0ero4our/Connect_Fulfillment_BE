
import express from 'express';
import orderRoutes from './routes/orderRoutes';

const app = express();
app.use(express.json());

app.use('/', orderRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'order-service' }));

app.listen(4002, () => console.log('order-service listening on 4002'));
