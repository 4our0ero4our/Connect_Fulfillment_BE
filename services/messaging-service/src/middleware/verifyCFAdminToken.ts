import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import mongoose, { Document } from 'mongoose';

interface IAdmin extends Document {
  adminName?: string;
  adminEmail: string;
  password: string;
}

const getAdminDBUri = (): string => {
  const adminMongoUri = process.env.ADMIN_MONGO_URI;
  if (adminMongoUri) {
    return adminMongoUri;
  }

  const defaultUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  if (defaultUri.includes('/') && !defaultUri.endsWith('/')) {
    const uriParts = defaultUri.split('?');
    const baseUri = uriParts[0];
    const queryString = uriParts[1] ? `?${uriParts[1]}` : '';
    const lastSlashIndex = baseUri.lastIndexOf('/');
    if (lastSlashIndex >= 0) {
      return baseUri.substring(0, lastSlashIndex + 1) + 'AdminDB' + queryString;
    }
  }
  return defaultUri + (defaultUri.includes('?') ? '' : '/') + 'AdminDB';
};

const adminConnection = mongoose.createConnection(getAdminDBUri(), {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

const AdminSchema = new mongoose.Schema<IAdmin>(
  {
    adminName: { type: String },
    adminEmail: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
  },
  { timestamps: true, collection: 'admins' }
);

const Admin =
  adminConnection.models.Admin || adminConnection.model<IAdmin>('Admin', AdminSchema);

/**
 * Middleware to verify CF Admin JWT token.
 * 
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function
 */
export const verifyCFAdminToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
    if (!admin) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only FulfillMate admins can access this resource'
      });
    }

    res.locals.isAdmin = true;
    res.locals.isCFAdmin = true;
    res.locals.adminId = decoded.adminId;
    res.locals.adminEmail = decoded.adminEmail;
    res.locals.adminName = decoded.adminName;

    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'Token verification failed'
    });
  }
};

