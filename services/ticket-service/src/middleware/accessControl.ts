import dotenv from 'dotenv';
import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import mongoose, { Schema, Document } from 'mongoose';
import axios from 'axios';

dotenv.config();

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

const AdminSchema = new Schema<IAdmin>(
  {
    adminName: { type: String },
    adminEmail: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
  },
  { timestamps: true, collection: 'admins' }
);

const Admin =
  adminConnection.models.Admin || adminConnection.model<IAdmin>('Admin', AdminSchema);

const COMPANY_SERVICE_URL = process.env.COMPANY_SERVICE_URL || 'http://company-service:4004';

/**
 * This function sets the company context in the response object
 * @param res - The response object
 * @param company - The company object
 */
const setCompanyContext = (res: Response, company: any) => {
  if (!company) return;
  res.locals.company = company;
  res.locals.companyId = company._id?.toString() || company.id?.toString();
  res.locals.companyName = company.companyName;
  res.locals.companyApiKey = company.companyApiKey;
  res.locals.companyEmail = company.companyEmail;
  res.locals.isMerchant = true;
};

/**
 * This function resolves the company context via headers
 * @param req - The request object
 * @param res - The response object
 * @returns The company object or null if not found
 */
const resolveCompanyViaHeaders = async (req: Request, res: Response): Promise<any | null> => {
  if (res.locals.company && res.locals.companyId) {
    return res.locals.company;
  }

  const headerCompanyId = req.headers['x-company-id'];
  const headerApiKey = req.headers['x-company-api-key'];

  if (headerCompanyId && headerApiKey) {
    const company = {
      _id: Array.isArray(headerCompanyId) ? headerCompanyId[0] : headerCompanyId,
      companyApiKey: Array.isArray(headerApiKey) ? headerApiKey[0] : headerApiKey,
      companyName: req.headers['x-company-name'] || 'Unknown Company',
    };
    setCompanyContext(res, company);
    return company;
  }

  const apiKey = req.headers['your_company_api_key'];
  if (apiKey) {
    const normalizedKey = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    try {
      const response = await axios.get(`${COMPANY_SERVICE_URL}/verify-key`, {
        headers: { your_company_api_key: normalizedKey },
        timeout: 5000,
      });

      if (response.data?.valid && response.data.company) {
        setCompanyContext(res, response.data.company);
        return response.data.company;
      }
    } catch (error) {
      console.error('Error verifying company API key:', (error as any)?.message);
    }
  }

  return null;
};

/**
 * This function verifies the admin token
 * @param token - The admin token
 * @param res - The response object
 * @returns True if the token is valid, false otherwise
 */
const verifyAdminToken = async (token: string, res: Response): Promise<boolean> => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    if (!decoded?.adminEmail) {
      return false;
    }

    const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
    if (!admin) {
      return false;
    }

    res.locals.isAdmin = true;
    res.locals.adminId = decoded.adminId;
    res.locals.adminEmail = decoded.adminEmail;
    res.locals.adminName = decoded.adminName;
    return true;
  } catch (error) {
    console.error('verifyAdminToken error:', (error as any)?.message);
    return false;
  }
};

/**
 * This middleware is used to require Connect Fulfillment Admin authentication
 * @param req - The request object
 * @param res - The response object
 * @param next - The next function
 */
export const requireCFAdmin = async (req: Request, res: Response, next: NextFunction) => {
  if (res.locals.isAdmin && res.locals.adminEmail) {
    return next();
  }

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({
      message: 'Access denied',
      error: 'CF Admin token is required',
    });
  }

  const valid = await verifyAdminToken(token, res);
  if (!valid) {
    return res.status(403).json({
      message: 'Access denied',
      error: 'Only Connect Fulfillment admins can perform this action',
    });
  }

  return next();
};

/**
 * This middleware is used to require company context
 * @param req - The request object
 * @param res - The response object
 * @param next - The next function
 */
export const requireCompanyContext = async (req: Request, res: Response, next: NextFunction) => {
  if (res.locals.companyId && res.locals.companyApiKey) {
    res.locals.isMerchant = true;
    return next();
  }

  const company = await resolveCompanyViaHeaders(req, res);
  if (!company) {
    return res.status(403).json({
      message: 'Access denied',
      error: 'Valid company API key or token is required',
    });
  }

  return next();
};

/**
 * This middleware is used to require admin or company context
 * @param req - The request object
 * @param res - The response object
 * @param next - The next function
 */
export const requireAdminOrCompany = async (req: Request, res: Response, next: NextFunction) => {
  if (res.locals.isAdmin && res.locals.adminEmail) {
    return next();
  }

  const token = req.headers.authorization?.split(' ')[1];
  if (token && (await verifyAdminToken(token, res))) {
    return next();
  }

  const company = await resolveCompanyViaHeaders(req, res);
  if (company) {
    return next();
  }

  return res.status(403).json({
    message: 'Access denied',
    error: 'Valid admin token or company API key is required',
  });
};

/**
 * This middleware is used to require internal service authentication
 * @param req - The request object
 * @param res - The response object
 * @param next - The next function
 */
export const requireInternalService = (req: Request, res: Response, next: NextFunction) => {
  const expectedToken = process.env.INTERNAL_SERVICE_TOKEN;
  const providedToken =
    req.headers['x-internal-token'] ||
    req.headers['authorization']?.replace(/Bearer\s+/i, '') ||
    req.headers['x-service-secret'];

  if (expectedToken && expectedToken === (Array.isArray(providedToken) ? providedToken[0] : providedToken)) {
    return next();
  }

  if (!expectedToken) {
    console.warn('INTERNAL_SERVICE_TOKEN is not set. Skipping internal auth check.');
    return next();
  }

  return res.status(401).json({
    message: 'Unauthorized request',
    error: 'Internal token is invalid or missing',
  });
};

