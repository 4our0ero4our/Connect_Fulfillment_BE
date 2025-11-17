import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Schema, Document } from 'mongoose';
import axios from 'axios';

// Admin model interface for AdminDB connection (similar to company-service)
interface IAdmin extends Document {
  adminName?: string;
  adminEmail?: string;
  password?: string;
}

const AdminSchema = new Schema<IAdmin>(
  {
    adminName: { type: String, required: false },
    adminEmail: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
  },
  { timestamps: true, collection: 'admins' }
);

// Get AdminDB URI - This particular manipulation dey sweet me anywhere I do am 🤗 Type shii 😂
const getAdminDBUri = (): string => {
  const adminMongoUri = process.env.ADMIN_MONGO_URI;
  if (adminMongoUri) {
    return adminMongoUri;
  }
  const defaultUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  if (defaultUri.includes('/') && !defaultUri.endsWith('/')) {
    const uriParts = defaultUri.split('?');
    const baseUri = uriParts[0];
    const queryString = uriParts[1] ? `?${uriParts[1]}` : '';
    const lastSlashIndex = baseUri.lastIndexOf('/');
    if (lastSlashIndex >= 0) {
      return baseUri.substring(0, lastSlashIndex + 1) + 'AdminDB' + queryString;
    }
  }
  return defaultUri + (defaultUri.includes('?') ? '' : '/') + 'AdminDB';
};

const adminDBConnection = mongoose.createConnection(getAdminDBUri(), {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

const Admin = adminDBConnection.models.Admin || adminDBConnection.model<IAdmin>('Admin', AdminSchema);

const getStaffsCollection = () => adminDBConnection.collection('staffs');

const isValidLeadCFAdmin = async (email: string): Promise<boolean> => {
  try {
    const normalizedEmail = email.toLowerCase();
    const staffsCollection = getStaffsCollection();
    
    // Try exact match first
    let staff = await staffsCollection.findOne({ email: normalizedEmail, isALeadCFAdmin: true });
    
    // If not found, try case-insensitive search (in case email wasn't stored as lowercase)
    if (!staff) {
      staff = await staffsCollection.findOne({ 
        email: { $regex: new RegExp(`^${normalizedEmail}$`, 'i') }, 
        isALeadCFAdmin: true 
      });
    }
    
    return staff ? true : false;
  } catch (error) {
    console.error('Error in isValidLeadCFAdmin:', error);
    return false;
  }
};

const COMPANY_SERVICE_URL = process.env.COMPANY_SERVICE_URL || 'http://company-service:4004';

const resolveCompanyFromContext = async (req: Request, res: Response): Promise<any | null> => {
  let company = res.locals.company as any;

  if (company && typeof company === 'object' && (company._id || company.id) && company.companyApiKey) {
    return company;
  }

  const companyIdHeader = req.headers['x-company-id'];
  const companyApiKeyHeader = req.headers['x-company-api-key'];
  const companyNameHeader = req.headers['x-company-name'];

  if (companyIdHeader && companyApiKeyHeader) {
    const companyId = Array.isArray(companyIdHeader) ? companyIdHeader[0] : companyIdHeader;
    const companyApiKey = Array.isArray(companyApiKeyHeader) ? companyApiKeyHeader[0] : companyApiKeyHeader;
    const companyName = Array.isArray(companyNameHeader) ? companyNameHeader[0] : companyNameHeader;
    company = {
      _id: companyId,
      companyApiKey,
      companyName: companyName || 'Unknown Company',
    };
    res.locals.company = company;
    return company;
  }

  const apiKeyFromRequest = req.headers['your_company_api_key'];
  if (apiKeyFromRequest) {
    const apiKey = Array.isArray(apiKeyFromRequest) ? apiKeyFromRequest[0] : apiKeyFromRequest;
    if (apiKey) {
      try {
        const response = await axios.get(`${COMPANY_SERVICE_URL}/verify-key`, {
          headers: { 'your_company_api_key': apiKey }
        });
        if (response.data?.valid && response.data.company) {
          const verifiedCompany = response.data.company;
          res.locals.company = verifiedCompany;
          return verifiedCompany;
        }
      } catch (error) {
        console.error('Error fetching company details from company-service:', (error as any)?.message);
      }
    }
  }

  return null;
};

// Middleware to verify if requester is a Connect Fulfillment admin
export const verifyCFAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check if admin info is already set by API Gateway
    if (res.locals.isAdmin && res.locals.adminEmail) {
      // Admin info already verified by gateway, verify it exists in Admin collection
      const admin = await Admin.findOne({ adminEmail: res.locals.adminEmail });
      if (!admin) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Only Connect Fulfillment admins can access this resource'
        });
      }
      return next();
    }

    // If not set by gateway, verify token directly
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    // Verify that the email from token exists in Admin collection
    const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
    if (!admin) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only Connect Fulfillment admins can access this resource'
      });
    }

    // Store admin info in res.locals
    res.locals.isAdmin = true;
    res.locals.adminId = decoded.adminId;
    res.locals.adminEmail = decoded.adminEmail;
    res.locals.adminName = decoded.adminName;
    
    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'Token verification failed'
    });
  }
};

// Middleware to verify if requester is a merchant (has valid API key)
// This middleware checks if company info is in res.locals (set by API Gateway)
export const verifyMerchant = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const company = await resolveCompanyFromContext(req, res);
  
    if (!company || (!company._id && !company.id) || !company.companyApiKey) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Valid company API key is required'
      });
    }
  
    res.locals.isMerchant = true;
    res.locals.companyId = company._id?.toString() || company.id?.toString();
    res.locals.companyApiKey = company.companyApiKey;
    res.locals.companyName = company.companyName;
    
    next();
  } catch (error) {
    console.error('verifyMerchant error:', (error as any)?.message);
    return res.status(500).json({
      message: 'Internal server error',
      error: 'Failed to validate merchant access'
    });
  }
};

// Middleware that allows either admin OR merchant/company admin
// CF Admin can access all orders, merchant/company admin can only access their own company's orders
export const verifyAdminOrMerchant = async (req: Request, res: Response, next: NextFunction) => {
  // Check if admin info is already set by API Gateway
  if (res.locals.isAdmin && res.locals.adminEmail) {
    // Admin info already verified by gateway, verify it exists in Admin collection
    const admin = await Admin.findOne({ adminEmail: res.locals.adminEmail });
    if (admin) {
      return next();
    }
  }

  // Check if company admin is already verified
  if (res.locals.isCompanyAdmin && res.locals.companyId) {
    return next();
  }

  // Check if admin token is provided (if not set by gateway)
  const token = req.headers.authorization?.split(' ')[1];
  
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
      
      // Check if it's a CF Admin token (has adminEmail)
      if (decoded.adminEmail) {
        const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
        
        if (admin) {
          // Valid CF Admin
          res.locals.isAdmin = true;
          res.locals.adminId = decoded.adminId;
          res.locals.adminEmail = decoded.adminEmail;
          res.locals.adminName = decoded.adminName;
          return next();
        }
      }
      
      // Check if it's a Company Admin token (has companyAdminEmail)
      if (decoded.companyAdminEmail) {
        // Import and use verifyCompanyAdmin logic
        const { verifyCompanyAdmin } = await import('./verifyCompanyAdmin');
        // Call verifyCompanyAdmin which will verify and set res.locals
        // We need to handle this differently since verifyCompanyAdmin is a middleware
        // Let's check company admin inline here
        
        const companyAdminEmail = decoded.companyAdminEmail.toLowerCase();
        const companyId = decoded.companyId;
        const companyApiKey = decoded.companyApiKey;
        
        if (companyId && companyApiKey) {
          // Verify company admin via company-service
          let companyAdminValid = false;
          let company: any = null;
          
          for (const baseUrl of [process.env.COMPANY_SERVICE_URL || 'http://company-service:4004']) {
            try {
              const response = await axios.get(`${baseUrl}/verify-key`, {
                headers: { 'your_company_api_key': companyApiKey },
                timeout: 5000,
              });
              
              if (response.data?.valid && response.data?.company) {
                company = response.data.company;
                
                // Verify company ID matches
                const companyIdStr = company._id?.toString() || company.id?.toString();
                if (companyIdStr === companyId && company.isVerified) {
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
              }
            } catch (error: any) {
              if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNREFUSED') {
                continue;
              }
              // Continue to next URL
            }
          }
          
          if (companyAdminValid && company) {
            // Valid Company Admin
            res.locals.isCompanyAdmin = true;
            res.locals.companyAdminId = decoded.companyAdminId;
            res.locals.companyAdminEmail = companyAdminEmail;
            res.locals.companyAdminName = decoded.companyAdminName;
            res.locals.company = company;
            res.locals.companyId = companyId;
            res.locals.companyApiKey = companyApiKey;
            res.locals.companyName = decoded.companyName || company.companyName;
            res.locals.companyEmail = company.companyEmail;
            res.locals.isMerchant = true; // Company admins have merchant-level access
            return next();
          }
        }
      }
    } catch (error) {
      // Token invalid, continue to check merchant API key
    }
  }

  // Check if merchant (API key validated by gateway)
  let company = await resolveCompanyFromContext(req, res);

  if (company && (company._id || company.id) && company.companyApiKey) {
    res.locals.isMerchant = true;
    res.locals.companyId = company._id?.toString() || company.id?.toString();
    res.locals.companyApiKey = company.companyApiKey;
    res.locals.companyName = company.companyName;
    return next();
  }

  // Neither admin nor merchant nor company admin
  return res.status(403).json({
    message: 'Access denied',
    error: 'Valid admin token, company admin token, or company API key is required'
  });
};

// Middleware to check if requester has access to a specific order
// Admin can access any order, merchant can only access their own orders
export const verifyOrderAccess = async (req: Request, res: Response, next: NextFunction) => {
  const orderId = req.params.orderId;
  const { Order } = await import('../models/Order');
  
  try {
    const order = await Order.findById(orderId);
    
    if (!order) {
      return res.status(404).json({
        message: 'Order not found',
        error: 'The order you are looking for does not exist'
      });
    }

    // Admin can access any order
    if (res.locals.isAdmin) {
      res.locals.order = order;
      return next();
    }

    // Merchant can only access their own orders
    if (res.locals.isMerchant) {
      // Compare companyId - handle both string and ObjectId
      const orderCompanyId = order.companyId.toString();
      const merchantCompanyId = res.locals.companyId?.toString();
      
      if (orderCompanyId !== merchantCompanyId) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'You do not have permission to access this order'
        });
      }
      res.locals.order = order;
      return next();
    }

    return res.status(403).json({
      message: 'Access denied',
      error: 'Valid authentication is required'
    });
  } catch (error: any) {
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
};

// Middleware to verify if requester is a lead CF Admin
export const verifyLeadCFAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN
    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    
    // Validate that adminEmail exists in token
    if (!decoded.adminEmail) {
      console.error('verifyLeadCFAdmin: Token missing adminEmail field');
      return res.status(401).json({
        message: 'Access denied',
        error: 'Invalid token: admin email not found'
      });
    }
    
    const adminEmail = decoded.adminEmail.toLowerCase();
    console.log(`verifyLeadCFAdmin: Checking admin email: ${adminEmail}`);
    
    // Verify admin exists in Admin collection
    const admin = await Admin.findOne({ adminEmail: adminEmail });
    if (!admin) {
      console.error(`verifyLeadCFAdmin: Admin not found in Admin collection for email: ${adminEmail}`);
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only Connect Fulfillment admins can access this resource'
      });
    }
    
    console.log(`verifyLeadCFAdmin: Admin found, checking lead admin status...`);
    
    // Check if admin is a lead CF admin
    const isLeadAdmin = await isValidLeadCFAdmin(decoded.adminEmail);
    if (!isLeadAdmin) {
      console.error(`verifyLeadCFAdmin: Admin ${adminEmail} is not a lead CF admin`);
      // Additional debug: check if staff exists at all
      const staffsCollection = mongoose.connection.collection('staffs');
      const staffExists = await staffsCollection.findOne({ email: adminEmail });
      if (!staffExists) {
        console.error(`verifyLeadCFAdmin: Staff record not found in staffs collection for email: ${adminEmail}`);
      } else {
        console.error(`verifyLeadCFAdmin: Staff found but isALeadCFAdmin is: ${staffExists.isALeadCFAdmin}`);
      }
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only lead Connect Fulfillment admins can perform this action'
      });
    }
    
    console.log(`verifyLeadCFAdmin: Lead admin verified successfully for: ${adminEmail}`);
    
    // Set admin info in res.locals for use in route handlers
    res.locals.isAdmin = true;
    res.locals.adminId = decoded.adminId;
    res.locals.adminEmail = adminEmail;
    res.locals.adminName = decoded.adminName;
    
    return next();
  } catch (error: any) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      console.error('verifyLeadCFAdmin: Token verification failed:', error.message);
      return res.status(401).json({
        message: 'Invalid token',
        error: 'Token verification failed'
      });
    }
    console.error('Error in verifyLeadCFAdmin:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: 'Failed to verify lead admin status'
    });
  }
};