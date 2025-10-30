import { Request, Response, NextFunction } from 'express';
import axios from 'axios';

export const validateApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers['your_company_api_key'] as string;

    if (!apiKey) {
      return res.status(401).json({ error: 'Company API key is required' });
    }

    // Call company-service to verify the key
    const response = await axios.get(`http://company-service:4004/verify-key`, {
      headers: { 'your_company_api_key': apiKey },
    });

    if (!response.data.valid) {
      return res.status(403).json({ error: 'Invalid Company API key' });
    }

    req.body.company = response.data.company;

    next();
  } catch (error: any) {
    console.error('API key validation error:', error?.message);
    return res.status(500).json({ error: 'Internal server error during Company API key validation' });
  }
};
