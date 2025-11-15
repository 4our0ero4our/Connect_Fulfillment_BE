import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { recordInvalidApiKeyAttempt } from './gatewayRateLimit';

const getCompanyServiceUrls = (): string[] => {
  const urls: string[] = [];
  if (process.env.COMPANY_SERVICE_URL) {
    urls.push(process.env.COMPANY_SERVICE_URL);
  }
  urls.push('http://company-service:4004');
  urls.push('http://localhost:4004');
  return Array.from(new Set(urls));
};

const fetchCompanyValidation = async (apiKey: string) => {
  let lastError: any;
  for (const baseUrl of getCompanyServiceUrls()) {
    try {
      const response = await axios.get(`${baseUrl}/verify-key`, {
        headers: { 'your_company_api_key': apiKey },
        timeout: 5000,
      });
      return { response, baseUrl };
    } catch (error: any) {
      lastError = error;
      if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNREFUSED') {
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('Company service validation failed');
};

export const validateApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check if admin token is present - allow admins to bypass API key check
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        // Verify admin token - allow admins to bypass API key check
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
        if (decoded.adminId || decoded.adminEmail) {
          console.log('Admin token verified, allowing access without API key');
          // Store admin info in res.locals for downstream services
          res.locals.isAdmin = true;
          res.locals.adminId = decoded.adminId;
          res.locals.adminEmail = decoded.adminEmail;
          res.locals.adminName = decoded.adminName;
          return next(); // Admin token valid, allow request
        }
      } catch (jwtError: any) {
        // Token invalid or expired - continue to check API key
        console.log('Admin token verification failed, checking API key instead');
      }
    }

    // No valid admin token, require company API key
    const apiKey = req.headers['your_company_api_key'] as string;

    if (!apiKey) {
      const attempt = await recordInvalidApiKeyAttempt(req);
      if (attempt.bannedNow) {
        return res.status(429).json({
          error: 'Too many invalid API key attempts. Access temporarily blocked.',
          retryAfterSeconds: attempt.retryAfterSeconds,
        });
      }
      return res.status(401).json({ error: 'API key validation failed: Company API key' });
    }

    const { response, baseUrl } = await fetchCompanyValidation(apiKey);

    if (!response.data.valid) {
      const attempt = await recordInvalidApiKeyAttempt(req);
      if (attempt.bannedNow) {
        return res.status(429).json({
          error: 'Too many invalid API key attempts. Access temporarily blocked.',
          retryAfterSeconds: attempt.retryAfterSeconds,
        });
      }
      return res.status(403).json({ error: 'API key validation failed: Invalid Company API key' });
    }
  
    const company = response.data.company;
    console.log(`Company API key is valid via ${baseUrl}`, company);
    res.locals.company = company ? company : 'No company details found';

    if (company) {
      const companyId = company._id || company.id;
      // Attach company info to headers so downstream services (proxied) can access it
      req.headers['x-company-id'] = companyId ? companyId.toString() : '';
      req.headers['x-company-api-key'] = company.companyApiKey || '';
      req.headers['x-company-name'] = company.companyName || '';
      req.headers['x-company-email'] = company.companyEmail || '';
      (req as any).company = company; // optional reference
    }

    next();
  } catch (error: any) {
    console.error('API key validation error:', error?.message);
    return res.status(500).json({ error: 'Internal server error during Company API key validation' });
  }
};
