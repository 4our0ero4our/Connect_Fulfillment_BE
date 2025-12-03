import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
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

interface CompanyAdminTokenPayload extends JwtPayload {
  companyAdminId?: number;
  companyAdminEmail?: string;
  companyAdminName?: string;
  companyId?: string;
  companyApiKey?: string;
  companyName?: string;
}

/**
 * Middleware to verify company admin JWT token
 * Verifies that the token is valid and the company admin exists in the company's companyAdminIDDetails array
 * Sets res.locals with company admin info and company info
 */
export const verifyCompanyAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided. Company admin authentication required.'
      });
    }

    // Verify JWT token
    let decoded: CompanyAdminTokenPayload;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as CompanyAdminTokenPayload;
    } catch (error) {
      return res.status(401).json({
        message: 'Invalid token',
        error: 'Token verification failed. Please login again.'
      });
    }

    // Check if token contains companyAdminEmail (to distinguish from CF admin tokens)
    if (!decoded.companyAdminEmail) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Invalid token type. Company admin token required.'
      });
    }

    const companyAdminEmail = decoded.companyAdminEmail.toLowerCase();
    const companyId = decoded.companyId;
    const companyApiKey = decoded.companyApiKey;
    const companyName = decoded.companyName;

    // If token doesn't have company info, try to get it from headers or verify via API key
    if (!companyId || !companyApiKey) {
      // Fallback: Try to get company info from headers
      const headerCompanyId = req.headers['x-company-id'];
      const headerCompanyApiKey = req.headers['x-company-api-key'] || req.headers['your_company_api_key'];
      
      if (headerCompanyId && headerCompanyApiKey) {
        // Use headers if available
        const apiKey = Array.isArray(headerCompanyApiKey) ? headerCompanyApiKey[0] : headerCompanyApiKey;
        const id = Array.isArray(headerCompanyId) ? headerCompanyId[0] : headerCompanyId;
        
        // Verify company and admin via company-service
        let company: any = null;
        let companyAdminValid = false;
        
        for (const baseUrl of getCompanyServiceUrls()) {
          try {
            const response = await axios.get(`${baseUrl}/verify-key`, {
              headers: { 'your_company_api_key': apiKey },
              timeout: 5000,
            });
            
            if (response.data?.valid && response.data?.company) {
              company = response.data.company;
              
              // Verify company ID matches
              const companyIdStr = company._id?.toString() || company.id?.toString();
              if (companyIdStr !== id) {
                return res.status(403).json({
                  message: 'Access denied',
                  error: 'Company ID mismatch'
                });
              }
              
              // Check if the company admin email exists in companyAdminIDDetails
              if (company.companyAdminIDDetails && Array.isArray(company.companyAdminIDDetails)) {
                const adminExists = company.companyAdminIDDetails.find(
                  (admin: any) => admin.companyAdminEmail?.toLowerCase() === companyAdminEmail
                );
                
                if (adminExists) {
                  companyAdminValid = true;
                  break;
                }
              }
            }
          } catch (error: any) {
            if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNREFUSED') {
              continue;
            }
          }
        }
        
        if (!companyAdminValid || !company) {
          return res.status(403).json({
            message: 'Access denied',
            error: 'Company admin not found or not authorized. Please verify your credentials.'
          });
        }
        
        // Verify company is verified and active
        if (!company.isVerified) {
          return res.status(403).json({
            message: 'Access denied',
            error: 'Company is not verified. Please contact Connect Fulfillment support.'
          });
        }
        
        if (!company.isActive) {
          return res.status(403).json({
            message: 'Access denied',
            error: 'Company account is deactivated. Please contact Connect Fulfillment support.'
          });
        }
        
        // Set company info from verified company
        res.locals.company = company;
        res.locals.companyId = company._id?.toString() || company.id?.toString();
        res.locals.companyApiKey = company.companyApiKey;
        res.locals.companyName = company.companyName;
        res.locals.companyEmail = company.companyEmail;
      } else {
        return res.status(400).json({
          message: 'Missing company context',
          error: 'Company information not found in token or headers. Please login again or provide company API key.'
        });
      }
    } else {
      // Token has company info, verify it with company-service
      let company: any = null;
      let companyAdminValid = false;
      
      for (const baseUrl of getCompanyServiceUrls()) {
        try {
          const response = await axios.get(`${baseUrl}/verify-key`, {
            headers: { 'your_company_api_key': companyApiKey },
            timeout: 5000,
          });
          
          if (response.data?.valid && response.data?.company) {
            company = response.data.company;
            
            // Verify company ID matches token
            const companyIdStr = company._id?.toString() || company.id?.toString();
            if (companyIdStr !== companyId) {
              return res.status(403).json({
                message: 'Access denied',
                error: 'Company ID in token does not match company API key'
              });
            }
            
            // Check if the company admin email exists in companyAdminIDDetails
            if (company.companyAdminIDDetails && Array.isArray(company.companyAdminIDDetails)) {
              const adminExists = company.companyAdminIDDetails.find(
                (admin: any) => admin.companyAdminEmail?.toLowerCase() === companyAdminEmail
              );
              
              if (adminExists) {
                companyAdminValid = true;
                break;
              }
            }
          }
        } catch (error: any) {
          if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNREFUSED') {
            continue;
          }
        }
      }
      
      if (!companyAdminValid || !company) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Company admin not found or not authorized. Please verify your credentials.'
        });
      }
      
      // Verify company is verified and active
      if (!company.isVerified) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Company is not verified. Please contact Connect Fulfillment support.'
        });
      }
      
      if (!company.isActive) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Company account is deactivated. Please contact Connect Fulfillment support.'
        });
      }
      
      // Use company info from token (already verified above)
      res.locals.company = company;
      res.locals.companyId = companyId;
      res.locals.companyApiKey = companyApiKey;
      res.locals.companyName = companyName || company.companyName;
      res.locals.companyEmail = company.companyEmail;
    }

    // Set company admin info in res.locals
    res.locals.isCompanyAdmin = true;
    res.locals.companyAdminId = decoded.companyAdminId;
    res.locals.companyAdminEmail = companyAdminEmail;
    res.locals.companyAdminName = decoded.companyAdminName;

    // Also set merchant flag for compatibility with existing code
    // Company admins should have the same access as merchants (their own company's orders)
    res.locals.isMerchant = true;

    next();
  } catch (error: any) {
    console.error('verifyCompanyAdmin error:', error?.message || error);
    return res.status(500).json({
      message: 'Internal server error',
      error: 'Company admin verification failed'
    });
  }
};

