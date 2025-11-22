import express from 'express';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import ticketRoutes from './routes/ticketRoutes';
import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import { connectKafkaProducer, disconnectKafkaProducer } from './utils/kafkaProducer';
import jwt from 'jsonwebtoken';
import cors from 'cors';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration for WebSocket
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
});

// Increase timeout for requests
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors());

// Add timeout middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  req.setTimeout(30000);
  res.setTimeout(30000);
  next();
});

// Connect to MongoDB
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
    console.log('MongoDB URI:', mongoURI.replace(/\/\/.*@/, '//***:***@'));
    
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      bufferCommands: false,
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 30000,
      retryWrites: true,
      retryReads: true
    });
    
    isConnected = true;
    isConnecting = false;
    console.log('✅ Connected to MongoDB successfully (messaging-service)');
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

connectToMongoDB();

// Connect Kafka producer
const connectKafkaWithRetry = async () => {
  const connected = await connectKafkaProducer();
  if (!connected) {
    console.log('⚠️  Retrying Kafka connection in 5 seconds...');
    setTimeout(connectKafkaWithRetry, 5000);
  }
};

connectKafkaWithRetry();

// MongoDB connection events
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
  console.log('✅ MongoDB reconnected successfully (messaging-service)');
  isConnected = true;
});

mongoose.connection.on('connected', () => {
  console.log('✅ MongoDB connected (messaging-service)');
  isConnected = true;
});

// WebSocket authentication and connection handling
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
    
    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    
    // Attach user info to socket
    socket.data.user = {
      id: decoded.adminId || decoded.companyAdminId,
      email: decoded.adminEmail || decoded.companyAdminEmail,
      name: decoded.adminName || decoded.companyAdminName,
      type: decoded.adminEmail ? 'cf_admin' : 'merchant',
      companyId: decoded.companyId,
    };

    next();
  } catch (error) {
    next(new Error('Authentication error: Invalid token'));
  }
});

// WebSocket connection handling
io.on('connection', (socket) => {
  const user = socket.data.user;
  console.log(`✅ WebSocket connected: ${user.type} - ${user.email}`);

  // Join company room (for merchants) or admin room (for CF admins)
  if (user.type === 'merchant' && user.companyId) {
    socket.join(`company:${user.companyId}`);
    console.log(`📦 Merchant joined company room: company:${user.companyId}`);
  } else if (user.type === 'cf_admin') {
    socket.join('cf_admin:all');
    console.log(`👤 CF Admin joined admin room`);
  }

  // Join ticket-specific room
  socket.on('join_ticket', (ticketId: string) => {
    socket.join(`ticket:${ticketId}`);
    console.log(`💬 User joined ticket room: ticket:${ticketId}`);
  });

  // Leave ticket room
  socket.on('leave_ticket', (ticketId: string) => {
    socket.leave(`ticket:${ticketId}`);
    console.log(`👋 User left ticket room: ticket:${ticketId}`);
  });

  socket.on('disconnect', () => {
    console.log(`❌ WebSocket disconnected: ${user.email}`);
  });
});

// Helper function to broadcast to relevant rooms
export const broadcastTicketUpdate = (ticketId: string, companyId: string, event: string, data: any) => {
  // Broadcast to ticket-specific room
  io.to(`ticket:${ticketId}`).emit(event, data);
  
  // Broadcast to company room (for merchants)
  io.to(`company:${companyId}`).emit(event, data);
  
  // Broadcast to CF admin room
  io.to('cf_admin:all').emit(event, data);
};

export const broadcastMessage = (ticketId: string, companyId: string, messageData: any) => {
  broadcastTicketUpdate(ticketId, companyId, 'new_message', messageData);
};

export const broadcastTicketStatusUpdate = (ticketId: string, companyId: string, statusData: any) => {
  broadcastTicketUpdate(ticketId, companyId, 'ticket_status_updated', statusData);
};

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: isConnected ? 'ok' : 'degraded',
    service: 'messaging-service',
    database: isConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Add middleware to check database connection
app.use((req, res, next) => {
  if (!isConnected && req.path !== '/health') {
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Database connection not established. Please try again in a moment.',
      service: 'messaging-service'
    });
  }
  next();
});

// Routes
// import ticketRoutes from './routes/ticketRoutes';
import { setBroadcastFunctions } from './routes/ticketRoutes';
app.use('/', ticketRoutes);

// Set broadcast functions for routes (after WebSocket is initialized)
setBroadcastFunctions(broadcastMessage, broadcastTicketStatusUpdate);

const PORT = process.env.PORT || 4006;
httpServer.listen(PORT, () => {
  console.log(`🚀 Messaging service listening on port ${PORT}`);
  console.log(`📊 Health check available at http://localhost:${PORT}/health`);
  console.log(`🔌 WebSocket available at ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down messaging-service...');
  await disconnectKafkaProducer();
  io.close();
  await mongoose.connection.close();
  httpServer.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down messaging-service...');
  await disconnectKafkaProducer();
  io.close();
  await mongoose.connection.close();
  httpServer.close();
  process.exit(0);
});

