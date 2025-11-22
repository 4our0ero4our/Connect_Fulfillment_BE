import express from 'express';
import mongoose from 'mongoose';
import orderRoutes from './routes/orderRoutes';
import logRoutes from './routes/logRoutes';
import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { connectKafkaProducer, disconnectKafkaProducer } from './utils/kafkaProducer';
import { scheduleOrderDeletion } from './utils/orderDeletionScheduler';

dotenv.config();

const app = express();

// Increase timeout for requests
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Add timeout middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  req.setTimeout(30000); // 30 seconds
  res.setTimeout(30000); // 30 seconds
  next();
});

// Connect to MongoDB (non-blocking with retry logic)
const mongoURI = process.env.MONGO_URI!;
let isConnected: boolean = false;
let isConnecting: boolean = false;

const connectToMongoDB = async () => {
  // Prevent multiple simultaneous connection attempts
  if (isConnecting || mongoose.connection.readyState === 1) {
    return;
  }

  isConnecting = true;
  try {
    console.log('🔄 Attempting to connect to MongoDB...');
    console.log('MongoDB URI:', mongoURI.replace(/\/\/.*@/, '//***:***@')); // Hide credentials in logs
    
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 10000, // 10 seconds
      socketTimeoutMS: 45000, // 45 seconds
      bufferCommands: false,
      maxPoolSize: 10, // Maintain up to 10 socket connections
      minPoolSize: 2, // Maintain at least 2 socket connections
      maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
      retryWrites: true,
      retryReads: true
    });
    
    isConnected = true;
    isConnecting = false;
    console.log('✅ Connected to MongoDB successfully');
  } catch (error: any) {
    isConnected = false;
    isConnecting = false;
    console.error('❌ MongoDB connection error:', error.message);
    
    // Only retry if not already connected and not currently connecting
    if (mongoose.connection.readyState === 0) {
      console.log('⚠️  Retrying MongoDB connection in 5 seconds...');
      setTimeout(() => {
        if (mongoose.connection.readyState === 0) {
          connectToMongoDB();
        }
      }, 5000);
    }
  }
};

// Connect Kafka producer with retry logic (non-blocking)
const connectKafkaWithRetry = async () => {
  const connected = await connectKafkaProducer();
  if (!connected) {
    console.log('⚠️  Retrying Kafka connection in 5 seconds...');
    // Retry connection after 5 seconds
    setTimeout(connectKafkaWithRetry, 5000);
  }
};

connectKafkaWithRetry();

// Start order deletion scheduler
scheduleOrderDeletion();

// Handle MongoDB connection events
mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
  isConnected = false;
});

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected. Mongoose will attempt to reconnect automatically...');
  isConnected = false;
  // Don't manually reconnect - let Mongoose handle it with its built-in reconnection
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected successfully');
  isConnected = true;
});

mongoose.connection.on('connected', () => {
  console.log('✅ MongoDB connected');
  isConnected = true;
});

// Start MongoDB connection (non-blocking)
connectToMongoDB();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down order-service...');
  await disconnectKafkaProducer();
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down order-service...');
  await disconnectKafkaProducer();
  await mongoose.connection.close();
  process.exit(0);
});

// Add middleware to check database connection before processing order routes
app.use((req, res, next) => {
  if (!isConnected && req.path !== '/health') {
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Database connection not established. Please try again in a moment.',
      service: 'order-service'
    });
  }
  next();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: isConnected ? 'ok' : 'degraded', 
    service: 'order-service',
    database: isConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

app.use('/', orderRoutes);
app.use('/', logRoutes);

const PORT = process.env.PORT || 4002;
app.listen(PORT, () => {
  console.log(`🚀 Order service listening on port ${PORT}`);
  console.log(`📊 Health check available at http://localhost:${PORT}/health`);
});
