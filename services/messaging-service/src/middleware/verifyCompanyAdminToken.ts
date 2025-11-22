import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import axios from 'axios';

const COMPANY_SERVICE_URL = process.env.COMPANY_SERVICE_URL || 'http://company-service:4004';

/**
 * Middleware to verify company admin JWT token.
 * 
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function
 */
export const verifyCompanyAdminToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    // Verify company exists and is verified
    try {
      const response = await axios.get(`${COMPANY_SERVICE_URL}/verify-key`, {
        headers: { 'your_company_api_key': decoded.companyApiKey },
        timeout: 5000,
      });

      if (!response.data?.valid || !response.data?.company) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Company not found, not verified, or inactive'
        });
      }

      const company = response.data.company;

      // Verify admin exists in company
      const adminExists = (company.companyAdminIDDetails || []).find(
        (admin: { companyAdminEmail: string }) => 
          admin.companyAdminEmail?.toLowerCase() === decoded.companyAdminEmail?.toLowerCase()
      );

      if (!adminExists) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Company admin not found'
        });
      }

      res.locals.isCompanyAdmin = true;
      res.locals.companyId = company._id?.toString() || company.id?.toString();
      res.locals.companyName = company.companyName;
      res.locals.companyEmail = company.companyEmail;
      res.locals.companyApiKey = company.companyApiKey;
      res.locals.companyAdminEmail = decoded.companyAdminEmail;
      res.locals.companyAdminId = decoded.companyAdminId;
      res.locals.companyAdminName = decoded.companyAdminName;

      next();
    } catch (error: any) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Company verification failed'
      });
    }
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'Token verification failed'
    });
  }
};

