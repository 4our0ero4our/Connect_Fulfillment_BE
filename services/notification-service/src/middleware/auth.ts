import dotenv from 'dotenv';
import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import mongoose, { Schema, Document } from 'mongoose';

dotenv.config();

interface IAdmin extends Document {
  adminEmail: string;
  adminName?: string;
  password: string;
}

const getAdminUri = (): string => {
  if (process.env.ADMIN_MONGO_URI) return process.env.ADMIN_MONGO_URI;
  const base = process.env.MONGO_URI || 'mongodb://localhost:27017';
  if (base.includes('/') && !base.endsWith('/')) {
    const [path, query] = base.split('?');
    const idx = path.lastIndexOf('/');
    if (idx >= 0) {
      return `${path.substring(0, idx + 1)}AdminDB${query ? `?${query}` : ''}`;
    }
  }
  return `${base}${base.includes('?') ? '' : '/'}AdminDB`;
};

const adminConnection = mongoose.createConnection(getAdminUri(), {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

const AdminSchema = new Schema<IAdmin>(
  {
    adminEmail: { type: String, required: true, unique: true, lowercase: true },
    adminName: { type: String },
    password: { type: String, required: true },
  },
  { collection: 'admins', timestamps: true }
);

const Admin =
  adminConnection.models.Admin || adminConnection.model<IAdmin>('Admin', AdminSchema);

export const requireCFAdmin = async (req: Request, res: Response, next: NextFunction) => {
  if (res.locals.isAdmin && res.locals.adminEmail) {
    return next();
  }

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({
      message: 'Access denied',
      error: 'Admin token is required',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    if (!decoded?.adminEmail) {
      throw new Error('Token missing admin email');
    }

    const admin = await Admin.findOne({ adminEmail: decoded.adminEmail.toLowerCase() });
    if (!admin) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only Connect Fulfillment admins can perform this action',
      });
    }

    res.locals.isAdmin = true;
    res.locals.adminEmail = admin.adminEmail;
    res.locals.adminName = admin.adminName;
    res.locals.adminId = decoded.adminId;
    return next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: (error as any)?.message || 'Token verification failed',
    });
  }
};

export const requireInternalService = (req: Request, res: Response, next: NextFunction) => {
  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  if (!expected) {
    console.warn('INTERNAL_SERVICE_TOKEN not set. Skipping internal auth check.');
    return next();
  }

  const fromHeader =
    req.headers['x-internal-token'] ||
    req.headers['authorization']?.replace(/Bearer\s+/i, '') ||
    req.headers['x-service-secret'];

  const provided = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;

  if (provided === expected) {
    return next();
  }

  return res.status(401).json({
    message: 'Unauthorized request',
    error: 'Internal token missing or invalid',
  });
};

