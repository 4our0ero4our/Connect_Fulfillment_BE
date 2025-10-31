import { Request, Response, NextFunction } from 'express';
import axios from 'axios';

export const validateApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers['your_company_api_key'] as string;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key validation failed: Company API key is required' });
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
    res.locals.company = response.data.company ? response.data.company : 'No company details found';

    next();
  } catch (error: any) {
    console.error('API key validation error:', error?.message);
    return res.status(500).json({ error: 'Internal server error during Company API key validation' });
  }
};
