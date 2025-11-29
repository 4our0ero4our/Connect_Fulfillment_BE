import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import axios from 'axios';

const COMPANY_SERVICE_URL = process.env.COMPANY_SERVICE_URL || 'http://company-service:4004';
const COMPANY_CACHE_TTL_MS = 60 * 1000; // cache verification responses for 1 minute

type CachedCompany = {
  company: any;
  expiresAt: number;
};

const companyCache = new Map<string, CachedCompany>();

const getCachedCompany = (apiKey: string): any | null => {
  const cached = companyCache.get(apiKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt < Date.now()) {
    companyCache.delete(apiKey);
    return null;
  }
  return cached.company;
};

const cacheCompany = (apiKey: string, company: any) => {
  if (!company) {
    return;
  }
  companyCache.set(apiKey, {
    company,
    expiresAt: Date.now() + COMPANY_CACHE_TTL_MS,
  });
};

const fetchCompanyByApiKey = async (apiKey: string): Promise<any | null> => {
  if (!apiKey) {
    return null;
  }

  const cached = getCachedCompany(apiKey);
  if (cached) {
    return cached;
  }

  const response = await axios.get(`${COMPANY_SERVICE_URL}/verify-key`, {
    headers: { 'your_company_api_key': apiKey },
    timeout: 5000,
  });

  if (!response.data?.valid || !response.data?.company) {
    return null;
  }

  cacheCompany(apiKey, response.data.company);
  return response.data.company;
};

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
      const company = await fetchCompanyByApiKey(decoded.companyApiKey);

      if (!company) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Company not found, not verified, or inactive'
        });
      }

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

