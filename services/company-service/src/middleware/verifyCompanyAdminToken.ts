import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Company } from '../models/Company';

/**
 * Middleware to verify company admin JWT token.
 * 
 * Validates that the request is authenticated with a valid company admin token.
 * The token must contain company information and the company must be verified and active.
 * Sets company information in res.locals for use in route handlers.
 * 
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function
 */
export const verifyCompanyAdminToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    // Verify that the company exists and is verified
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

    // Verify that the admin email exists in the company's admin list
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

    // Set company and admin info in res.locals
    res.locals.isCompanyAdmin = true;
    res.locals.companyId = company._id.toString();
    res.locals.companyName = company.companyName;
    res.locals.companyEmail = company.companyEmail;
    res.locals.companyApiKey = company.companyApiKey;
    res.locals.companyAdminEmail = decoded.companyAdminEmail;
    res.locals.companyAdminId = decoded.companyAdminId;
    res.locals.companyAdminName = decoded.companyAdminName;

    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'Token verification failed'
    });
  }
};

