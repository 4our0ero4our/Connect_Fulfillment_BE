// TODO: Admin Reset Password Route
// TODO: Check the Admin Login Route to see if it's working properly.
// TODO: Add a route to check if the admin is logged in and if the token is valid.



import express from 'express';
import mongoose from 'mongoose';
import authRoutes from './routes/authRoutes';
import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';

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

const connectToMongoDB = async () => {
  try {
    console.log('🔄 Attempting to connect to MongoDB...');
    console.log('MongoDB URI:', mongoURI.replace(/\/\/.*@/, '//***:***@')); // Hide credentials in logs
    
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 10000, // 10 seconds
      socketTimeoutMS: 45000, // 45 seconds
      bufferCommands: false
    });
    
    isConnected = true;
    console.log('✅ Connected to MongoDB successfully');
  } catch (error: any) {
    isConnected = false;
    console.error('❌ MongoDB connection error:', error.message);
    console.log('⚠️  Retrying MongoDB connection in 5 seconds...');
    // Retry connection after 5 seconds
    setTimeout(connectToMongoDB, 5000);
  }
};

// Start MongoDB connection (non-blocking)
connectToMongoDB();

// Handle MongoDB connection events
mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected. Attempting to reconnect...');
  connectToMongoDB();
});

// Add middleware to check database connection before processing auth routes
app.use((req, res, next) => {
  if (!isConnected && req.path !== '/health') {
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Database connection not established. Please try again in a moment.',
      service: 'auth-service'
    });
  }
  next();
});

app.use('/', authRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: isConnected ? 'ok' : 'degraded', 
    service: 'auth-service',
    database: isConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`🚀 Auth service listening on port ${PORT}`);
  console.log(`📊 Health check available at http://localhost:${PORT}/health`);
});
 