
import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import ticketRoutes from './routes/ticketRoutes';
import { initRedis, redisClient } from './utils/cache';
import { startOrderStatusConsumer, disconnectKafka } from './utils/kafka';
import { createTicket } from './services/ticketService';

dotenv.config();

const app = express();
app.use(express.json({ limit: '5mb' }));

const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/TicketDB';
let mongoConnected = false;

const connectMongo = async () => {
  try {
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    mongoConnected = true;
    console.log('✅ Connected to MongoDB (ticket-service)');
  } catch (error) {
    mongoConnected = false;
    console.error('Mongo connection failed:', (error as any)?.message);
    setTimeout(connectMongo, 5000);
  }
};

connectMongo();
initRedis().catch((error) => {
  console.error('Redis init failed:', error.message);
});

startOrderStatusConsumer(async (event) => {
  try {
    if (!event?.newStatus || event.newStatus !== 'packed') {
      return;
    }

    await createTicket({
      orderId: event.orderId,
      orderNumber: event.orderNumber,
      companyId: event.companyId,
      companyName: event.companyName,
      companyEmail: event.companyEmail,
      customerInfo: event.customerInfo,
      items: event.items,
      totalAmount: event.totalAmount,
      currency: event.currency,
    });
  } catch (error) {
    console.error('Failed to generate ticket from Kafka event:', (error as any)?.message);
  }
}).catch((error) => {
  console.error('Kafka consumer failed to start for ticket-service:', error.message);
});

mongoose.connection.on('disconnected', () => {
  mongoConnected = false;
  console.warn('MongoDB disconnected. Retrying...');
  connectMongo();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!mongoConnected && req.path !== '/health') {
    return res.status(503).json({
      status: 'degraded',
      message: 'Database connection not ready. Please retry shortly.',
    });
  }
  next();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: mongoConnected ? 'ok' : 'degraded',
    service: 'ticket-service',
    database: mongoConnected ? 'connected' : 'disconnected',
    redis: redisClient.isOpen ? 'connected' : 'disconnected',
  });
});

app.use('/', ticketRoutes);

const PORT = process.env.PORT || 4003;
const server = app.listen(PORT, () => console.log(`ticket-service listening on ${PORT}`));

const shutdown = async () => {
  console.log('Shutting down ticket-service...');
  await disconnectKafka();
  if (redisClient.isOpen) {
    await redisClient.disconnect();
  }
  await mongoose.connection.close();
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
