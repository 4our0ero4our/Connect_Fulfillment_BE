import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Admin } from '../models/Admin';

const CF_ACCESS_COOKIE_NAME = process.env.CF_ADMIN_ACCESS_COOKIE_NAME || 'cf_access';
const rawCfJwtSecret = process.env.JWT_SECRET;
if (!rawCfJwtSecret) {
  throw new Error('JWT_SECRET environment variable is required for verifyCFAdminToken middleware.');
}
const CF_JWT_SECRET: string = rawCfJwtSecret;

// ✅ Working perfectly
// Middleware to verify JWT token and ensure the caller is a Connect Fulfillment platform admin (A more secure way to verify the token)
export const verifyCFAdminToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token && req.cookies && req.cookies[CF_ACCESS_COOKIE_NAME]) {
      token = req.cookies[CF_ACCESS_COOKIE_NAME];
    }

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, CF_JWT_SECRET) as JwtPayload;

    // Verify that the email from token exists in Admin collection
    const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
    if (!admin) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only Connect Fulfillment admins can access this resource'
      });
    }

    // Store admin info in res.locals to avoid overwriting request body
    res.locals.adminId = decoded.adminId;
    res.locals.adminEmail = decoded.adminEmail;
    res.locals.adminName = decoded.adminName;
    // Also set in req.body for backward compatibility with existing routes
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

