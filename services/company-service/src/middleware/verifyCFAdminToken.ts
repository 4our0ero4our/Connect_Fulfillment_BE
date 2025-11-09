import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import mongoose, { Schema, Document } from 'mongoose';

// Admin model interface and schema for AdminDB connection
interface IAdmin extends Document {
  adminName?: string;
  adminEmail?: string;
  password?: string;
}

const AdminSchema = new Schema<IAdmin>(
  {
    adminName: { type: String, required: false },
    adminEmail: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
  },
  { timestamps: true, collection: 'admins' }
);

// Creates a separate connection to AdminDB for Admin model verification to avoid conflicts with the default connection to AdminDB in the AdminDB service.
const getAdminDBUri = (): string => {
  const adminMongoUri = process.env.ADMIN_MONGO_URI;
  if (adminMongoUri) {
    return adminMongoUri;
  }
  // If no separate URI, modify the default MONGO_URI to use AdminDB
  const defaultUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  // Replace the database name in the URI with 'AdminDB'
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

const adminDBConnection = mongoose.createConnection(getAdminDBUri(), {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

adminDBConnection.on('connected', () => {
  console.log('✅ Connected to AdminDB for Admin verification');
});

adminDBConnection.on('error', (err) => {
  console.error('❌ AdminDB connection error:', err);
});

// Create Admin model using the AdminDB connection
const Admin = adminDBConnection.models.Admin || adminDBConnection.model<IAdmin>('Admin', AdminSchema);

// ✅ Working perfectly
// Middleware to verify JWT token and ensure the caller is a Connect Fulfillment platform admin
export const verifyCFAdminToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    // Verify that the email from token exists in Admin collection (AdminDB)
    const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
    if (!admin) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only Connect Fulfillment admins can access this resource'
      });
    }

    req.body.adminId = decoded.adminId;
    req.body.adminEmail = decoded.adminEmail;
    req.body.adminName = decoded.adminName;
    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'Token verification failed'
    });
  }
};

