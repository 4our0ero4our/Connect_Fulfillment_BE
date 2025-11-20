
import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import notifyRoutes from './routes/notifyRoutes';
import { startNotificationConsumers, disconnectKafka } from './utils/kafka';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));

const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/NotificationDB';
let dbReady = false;

const connectMongo = async () => {
  try {
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    dbReady = true;
    console.log('✅ Connected to MongoDB (notification-service)');
  } catch (error) {
    dbReady = false;
    console.error('Notification Mongo connection failed:', (error as any)?.message);
    setTimeout(connectMongo, 5000);
  }
};

connectMongo();

startNotificationConsumers().catch((error) => {
  console.error('Kafka consumer failed to start:', error.message);
});

mongoose.connection.on('disconnected', () => {
  dbReady = false;
  connectMongo();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!dbReady && req.path !== '/health') {
    return res.status(503).json({
      status: 'degraded',
      message: 'Notification database connection not ready',
    });
  }
  next();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: dbReady ? 'ok' : 'degraded',
    service: 'notification-service',
    database: dbReady ? 'connected' : 'disconnected',
  });
});

app.use('/', notifyRoutes);

const PORT = process.env.PORT || 4005;
const server = app.listen(PORT, () => console.log(`notification-service listening on ${PORT}`));

const shutdown = async () => {
  console.log('Shutting down notification-service...');
  await disconnectKafka();
  await mongoose.connection.close();
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);