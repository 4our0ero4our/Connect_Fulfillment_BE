import { Request, Response, NextFunction } from 'express';
import axios from 'axios';

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

export const verifyCompanyApiKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (res.locals.company && typeof res.locals.company === 'object') {
      return next();
    }

    const headerCompanyId = req.headers['x-company-id'];
    const headerCompanyApiKey = req.headers['x-company-api-key'];
    const headerCompanyName = req.headers['x-company-name'];
    const headerCompanyEmail = req.headers['x-company-email'];

    if (headerCompanyId && headerCompanyApiKey) {
      const companyId = Array.isArray(headerCompanyId) ? headerCompanyId[0] : headerCompanyId;
      const companyApiKey = Array.isArray(headerCompanyApiKey) ? headerCompanyApiKey[0] : headerCompanyApiKey;
      const companyName = Array.isArray(headerCompanyName) ? headerCompanyName[0] : headerCompanyName;
      const companyEmail = Array.isArray(headerCompanyEmail) ? headerCompanyEmail[0] : headerCompanyEmail;

      res.locals.company = {
        _id: companyId,
        companyApiKey,
        companyName,
        companyEmail,
      };
      res.locals.companyId = companyId;
      res.locals.companyApiKey = companyApiKey;
      res.locals.companyName = companyName;
      res.locals.isMerchant = true;
      return next();
    }

    const apiKeyHeader = req.headers['your_company_api_key'] || req.headers['x-company-api-key'];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

    if (!apiKey) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Valid company API key is required'
      });
    }

    const { response } = await fetchCompanyValidation(apiKey as string);

    if (!response.data?.valid || !response.data?.company) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Valid company API key is required'
      });
    }

    const company = response.data.company;

    res.locals.company = company;
    res.locals.companyId = company._id?.toString() || company.id?.toString();
    res.locals.companyApiKey = company.companyApiKey;
    res.locals.companyName = company.companyName;
    res.locals.isMerchant = true;

    req.headers['x-company-id'] = res.locals.companyId;
    req.headers['x-company-api-key'] = company.companyApiKey;
    req.headers['x-company-name'] = company.companyName || '';
    req.headers['x-company-email'] = company.companyEmail || '';

    next();
  } catch (error: any) {
    console.error('verifyCompanyApiKey error:', error?.message || error);
    return res.status(500).json({
      message: 'Internal server error',
      error: 'Company API key validation failed'
    });
  }
};
