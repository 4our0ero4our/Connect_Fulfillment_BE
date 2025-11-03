import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';

export const validateApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check if admin token is present
    // const authHeader = req.headers.authorization;
    // if (authHeader && authHeader.startsWith('Bearer ')) {
    //   const token = authHeader.split(' ')[1];
    //   try {
    //     // Verify admin token - allow admins to bypass API key check
    //     const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    //     if (decoded.adminId || decoded.adminEmail) {
    //       console.log('Admin token verified, allowing access');
    //       return next(); // Admin token valid, allow request
    //     }
    //   } catch (jwtError: any) {
    //     console.error('Admin token verification error:', jwtError?.message);
    //     return res.status(401).json({ error: 'API key validation failed: Invalid Admin token' });
    //   }
    // }

    // No valid admin token, require company API key
    const apiKey = req.headers['your_company_api_key'] as string;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key validation failed: Company API key' });
    }

    // Calls company-service to verify the API key
    const response = await axios.get(`http://company-service:4004/verify-key`, {
      headers: { 'your_company_api_key': apiKey },
    });

    if (!response.data.valid) {
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
