import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Schema, Document } from 'mongoose';

// Admin model interface for AdminDB connection (similar to company-service)
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

// Get AdminDB URI
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

// Middleware to verify if requester is a Connect Fulfillment admin
export const verifyCFAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check if admin info is already set by API Gateway
    if (res.locals.isAdmin && res.locals.adminEmail) {
      // Admin info already verified by gateway, verify it exists in Admin collection
      const admin = await Admin.findOne({ adminEmail: res.locals.adminEmail });
      if (!admin) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Only Connect Fulfillment admins can access this resource'
        });
      }
      return next();
    }

    // If not set by gateway, verify token directly
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    // Verify that the email from token exists in Admin collection
    const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
    if (!admin) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only Connect Fulfillment admins can access this resource'
      });
    }

    // Store admin info in res.locals
    res.locals.isAdmin = true;
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

// Middleware to verify if requester is a merchant (has valid API key)
// This middleware checks if company info is in res.locals (set by API Gateway)
export const verifyMerchant = (req: Request, res: Response, next: NextFunction) => {
  // API Gateway validates API key and attaches company info to res.locals
  const company = res.locals.company;
  
  if (!company || (!company._id && !company.id) || !company.companyApiKey) {
    return res.status(403).json({
      message: 'Access denied',
      error: 'Valid company API key is required'
    });
  }

  // Store company info in res.locals for route handlers
  res.locals.isMerchant = true;
  res.locals.companyId = company._id?.toString() || company.id?.toString();
  res.locals.companyApiKey = company.companyApiKey;
  res.locals.companyName = company.companyName;
  
  next();
};

// Middleware that allows either admin OR merchant
// Admin can access all orders, merchant can only access their own orders
export const verifyAdminOrMerchant = async (req: Request, res: Response, next: NextFunction) => {
  // Check if admin info is already set by API Gateway
  if (res.locals.isAdmin && res.locals.adminEmail) {
    // Admin info already verified by gateway, verify it exists in Admin collection
    const admin = await Admin.findOne({ adminEmail: res.locals.adminEmail });
    if (admin) {
      return next();
    }
  }

  // Check if admin token is provided (if not set by gateway)
  const token = req.headers.authorization?.split(' ')[1];
  
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
      const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
      
      if (admin) {
        // Valid admin
        res.locals.isAdmin = true;
        res.locals.adminId = decoded.adminId;
        res.locals.adminEmail = decoded.adminEmail;
        res.locals.adminName = decoded.adminName;
        return next();
      }
    } catch (error) {
      // Token invalid or not an admin, continue to check merchant
    }
  }

  // Check if merchant (API key validated by gateway)
  const company = res.locals.company;
  if (company && (company._id || company.id) && company.companyApiKey) {
    res.locals.isMerchant = true;
    res.locals.companyId = company._id?.toString() || company.id?.toString();
    res.locals.companyApiKey = company.companyApiKey;
    res.locals.companyName = company.companyName;
    return next();
  }

  // Neither admin nor merchant
  return res.status(403).json({
    message: 'Access denied',
    error: 'Valid admin token or company API key is required'
  });
};

// Middleware to check if requester has access to a specific order
// Admin can access any order, merchant can only access their own orders
export const verifyOrderAccess = async (req: Request, res: Response, next: NextFunction) => {
  const orderId = req.params.orderId;
  const { Order } = await import('../models/Order');
  
  try {
    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({
        message: 'Order not found',
        error: 'The order you are looking for does not exist'
      });
    }

    // Admin can access any order
    if (res.locals.isAdmin) {
      res.locals.order = order;
      return next();
    }

    // Merchant can only access their own orders
    if (res.locals.isMerchant) {
      // Compare companyId - handle both string and ObjectId
      const orderCompanyId = order.companyId.toString();
      const merchantCompanyId = res.locals.companyId?.toString();
      
      if (orderCompanyId !== merchantCompanyId) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'You do not have permission to access this order'
        });
      }
      res.locals.order = order;
      return next();
    }

    return res.status(403).json({
      message: 'Access denied',
      error: 'Valid authentication is required'
    });
  } catch (error: any) {
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
};

