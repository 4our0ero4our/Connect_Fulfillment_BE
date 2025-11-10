import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { recordInvalidApiKeyAttempt } from './gatewayRateLimit';

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

    // Calls company-service to verify the API key
    const companyServiceBaseUrl = process.env.COMPANY_SERVICE_URL || 'http://company-service:4004';
    const response = await axios.get(`${companyServiceBaseUrl}/verify-key`, {
      headers: { 'your_company_api_key': apiKey },
    });

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
  
    console.log('Company API key is valid', response.data.company);
    // Attaches company details to response locals
    console.log('Company details:', response.data.company);
    res.locals.company = response.data.company ? response.data.company : 'No company details found';

    next();
  } catch (error: any) {
    console.error('API key validation error:', error?.message);
    return res.status(500).json({ error: 'Internal server error during Company API key validation' });
  }
};
