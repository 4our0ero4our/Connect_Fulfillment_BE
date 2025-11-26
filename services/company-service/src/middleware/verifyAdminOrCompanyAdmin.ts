import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Company } from '../models/Company';
import mongoose, { Schema, Document } from 'mongoose';

// Admin model for CF Admin verification
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

const adminDBConnection = mongoose.createConnection(getAdminDBUri(), {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

const Admin = adminDBConnection.models.Admin || adminDBConnection.model<IAdmin>('Admin', AdminSchema);

const CF_ACCESS_COOKIE_NAME = process.env.CF_ADMIN_ACCESS_COOKIE_NAME || 'cf_access';
const rawJwtSecret = process.env.JWT_SECRET;
if (!rawJwtSecret) {
  throw new Error('JWT_SECRET environment variable is required');
}
const JWT_SECRET: string = rawJwtSecret;

/**
 * Middleware that allows both CF Admins and Company Admins.
 * Tries CF Admin first, then falls back to Company Admin.
 * Sets appropriate flags in res.locals for access control.
 */
export const verifyAdminOrCompanyAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    // Check for CF admin cookie
    if (!token && req.cookies && req.cookies[CF_ACCESS_COOKIE_NAME]) {
      token = req.cookies[CF_ACCESS_COOKIE_NAME];
    }

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    // Try CF Admin first
    if (decoded.adminEmail) {
      const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
      if (admin) {
        res.locals.isCFAdmin = true;
        res.locals.isAdmin = true;
        res.locals.adminEmail = decoded.adminEmail;
        res.locals.adminName = decoded.adminName;
        res.locals.adminId = decoded.adminId;
        req.body.adminId = decoded.adminId;
        req.body.adminEmail = decoded.adminEmail;
        req.body.adminName = decoded.adminName;
        return next();
      }
    }

    // Try Company Admin
    if (decoded.companyAdminEmail && decoded.companyApiKey) {
      const company = await Company.findOne({
        companyApiKey: decoded.companyApiKey,
        isVerified: true,
        isActive: true
      });

      if (!company) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Company not found, not verified, or inactive'
        });
      }

      const adminExists = (company.companyAdminIDDetails || []).find(
        (admin: { companyAdminEmail: string }) =>
          admin.companyAdminEmail.toLowerCase() === decoded.companyAdminEmail?.toLowerCase()
      );

      if (!adminExists) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Company admin not found'
        });
      }

      res.locals.isCompanyAdmin = true;
      res.locals.companyId = company._id.toString();
      res.locals.companyName = company.companyName;
      res.locals.companyEmail = company.companyEmail;
      res.locals.companyApiKey = company.companyApiKey;
      res.locals.companyAdminEmail = decoded.companyAdminEmail;
      res.locals.companyAdminId = decoded.companyAdminId;
      res.locals.companyAdminName = decoded.companyAdminName;
      return next();
    }

    // Neither CF Admin nor Company Admin
    return res.status(401).json({
      message: 'Access denied',
      error: 'Valid admin token required (CF Admin or Company Admin)'
    });
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'Token verification failed'
    });
  }
};

