// This route is strictly for the companies to register itself in the system. They will be able to register themselves by providing their name, email, address, phone, website, logo, description, category, and sub-category as defined in the Company model.
import { Router } from 'express';
import { Request, Response } from 'express';
import { Company } from '../models/Company';
import crypto from 'crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import mongoose, { Schema, model } from 'mongoose';
import axios from 'axios';
// Attempt to use bcryptjs if available; fallback to crypto.scrypt otherwise
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bcrypt: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  bcrypt = require('bcryptjs');
} catch { }

const verifyPassword = async (plainText: string, hashedValue: string): Promise<boolean> => {
  if (bcrypt && typeof bcrypt.compare === 'function') {
    return bcrypt.compare(plainText, hashedValue);
  }

  const [salt, storedHash] = (hashedValue || '').split(':');
  if (!salt || !storedHash) {
    return false;
  }

  try {
    const storedBuffer = Buffer.from(storedHash, 'hex');
    const derived = scryptSync(plainText, salt, storedBuffer.length).toString('hex');
    return timingSafeEqual(storedBuffer, Buffer.from(derived, 'hex'));
  } catch {
    return false;
  }
};
const router = Router();

// Admin model interface and schema for AdminDB connection
interface IAdmin extends mongoose.Document {
  adminName?: string;
  adminEmail?: string;
  password?: string;
}

const AdminSchema = new Schema<IAdmin>({
  adminName: { type: String, required: false },
  adminEmail: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
}, { timestamps: true, collection: 'admins' });

// Creates a separate connection to AdminDB for Admin model verification to avoid conflicts with the default connection to AdminDB in the AdminDB service.
const getAdminDBUri = (): string => {
  const adminMongoUri = process.env.ADMIN_MONGO_URI;
  if (adminMongoUri) {
    return adminMongoUri;
  }
  // If no separate URI, modify the default MONGO_URI to use AdminDB
  const defaultUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  // Replace the database name in the URI with 'AdminDB'
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

adminDBConnection.on('connected', () => {
  console.log('✅ Connected to AdminDB for Admin verification');
});

adminDBConnection.on('error', (err) => {
  console.error('❌ AdminDB connection error:', err);
});

// Create Admin model using the AdminDB connection
const Admin = adminDBConnection.models.Admin || adminDBConnection.model<IAdmin>('Admin', AdminSchema);

// Middleware to verify JWT token and ensure the caller is a Connect Fulfillment platform admin
export const verifyCFAdminToken = async (req: Request, res: Response, next: any) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;

    // Verify that the email from token exists in Admin collection (AdminDB)
    const admin = await Admin.findOne({ adminEmail: decoded.adminEmail });
    if (!admin) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only Connect Fulfillment admins can access this resource'
      });
    }

    req.body.adminId = decoded.adminId;
    req.body.adminEmail = decoded.adminEmail;
    req.body.adminName = decoded.adminName;
    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'Token verification failed'
    });
  }
};

// ✅ Working perfectly 
// Health check endpoint
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Company Service is running', service: 'company-service' });
});

// ✅ Working perfectly
// Middleware to verify JWT token
export const verifyToken = (req: Request, res: Response, next: any) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    req.body.adminId = decoded.adminId;
    req.body.adminEmail = decoded.adminEmail;
    req.body.adminName = decoded.adminName;
    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'Token verification failed'
    });
  }
};

// ✅ Working perfectly
// Register company endpoint (to register a new company)
// The required API key to register a company will be that of the Connect Fulfillment company.
router.post('/register', async (req: Request, res: Response) => {
  try {
    if (!req.body.companyName || !req.body.companyEmail || !req.body.companyAddress || !req.body.companyPhone || !req.body.companyWebsite || !req.body.companyLogo || !req.body.companyDescription || !req.body.companyDetails || !req.body.companyCategory || !req.body.companySubCategory) {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          companyName: !req.body.companyName ? 'Company name is required' : null,
          companyEmail: !req.body.companyEmail ? 'Company email is required' : null,
          companyAddress: !req.body.companyAddress ? 'Company address is required' : null,
          companyPhone: !req.body.companyPhone ? 'Company phone is required' : null,
          companyWebsite: !req.body.companyWebsite ? 'Company website is required' : null,
          companyLogo: !req.body.companyLogo ? 'Company logo is required' : null,
          companyDescription: !req.body.companyDescription ? 'Company description is required' : null,
          companyDetails: !req.body.companyDetails ? 'Company details are required' : null,
          companyCategory: !req.body.companyCategory ? 'Company category is required' : null,
          companySubCategory: !req.body.companySubCategory ? 'Company sub-category is required' : null
        }
      });
    }
    const { companyName, companyEmail, companyAddress, companyPhone, companyWebsite, companyLogo, companyDescription, companyDetails, companyCategory, companySubCategory, isVerified } = req.body;

    // Generates strong random API key
    const generateApiKey = () => `CFK_${crypto.randomBytes(48).toString('base64url')}`; // ~64 chars

    // Ensure unlikely collision is handled
    let companyApiKey = generateApiKey();
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await Company.findOne({ companyApiKey });
      if (!exists) break;
      companyApiKey = generateApiKey();
    }

    const company = await Company.create({ companyName, companyEmail, companyAddress, companyPhone, companyWebsite, companyLogo, companyDescription, companyDetails, companyCategory, companySubCategory, companyApiKey, isVerified });

    const companySafe = company.toObject();
    delete (companySafe as any).companyApiKey;
    res.status(201).json({ message: 'Company registered successfully', company: companySafe });
  } catch (error: any) {
    res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
})

// ✅ Working perfectly
// Company Admin Registration endpoint (to register a company admin)
router.post('/company-admin/register', async (req: Request, res: Response) => {
  try {
    if (!req.body.companyAdminName || !req.body.companyAdminEmail || !req.body.companyAdminPassword) {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          companyAdminName: !req.body.companyAdminName ? 'Company admin name is required' : null,
          companyAdminEmail: !req.body.companyAdminEmail ? 'Company admin email is required' : null,
          companyAdminPassword: !req.body.companyAdminPassword ? 'Company admin password is required' : null,
          // companyApiKey: !req.body.companyApiKey ? 'Company API key is required' : null // Company API key is required in the header (your_company_api_key)
        }
      });
    }
    const { companyAdminName, companyAdminEmail, companyAdminPassword } = req.body;
    const companyApiKey = req.headers['your_company_api_key'] as string;

    // Ensures company exists and is verified by checking the API key in the header (your_company_api_key) in the Company model in the companyDB.
    const companyExists = await Company.findOne({ companyApiKey: companyApiKey });
    if (!companyExists || !companyExists.isVerified) {
      return res.status(401).json({ message: 'Invalid credentials', error: 'Company not found with this API key or company is not verified' });
    }

    // Checks if the admin email is linked to this company by checking the companyAdminEmails array in the Company model in the companyDB.
    const adminEmailListed = (companyExists.companyAdminEmails || []).includes(companyAdminEmail);
    if (!adminEmailListed) {
      return res.status(409).json({ message: 'Admin not linked to this company', error: 'Company admin is not linked to this company' });
    }
    // Checks if the admin already exists in the companyAdminIDDetails array in the Company model in the companyDB.
    const adminAlreadyExists = companyExists.companyAdminIDDetails.find((admin: { companyAdminEmail: string }) => admin.companyAdminEmail === companyAdminEmail);

    if (adminAlreadyExists) {
      return res.status(409).json({ message: 'Admin already exists', error: 'Admin already exists with this email for this company' });
    }

    // Hashes the company admin password 
    let hashedPassword: string;
    if (bcrypt && typeof bcrypt.hash === 'function') {
      hashedPassword = await bcrypt.hash(companyAdminPassword, 12);
    } else {
      const salt = randomBytes(16).toString('hex');
      const derived = scryptSync(companyAdminPassword, salt, 64).toString('hex');
      hashedPassword = `${salt}:${derived}`;
    }

    // Pushes the company admin to the companyAdminIDDetails array in the Company model in the companyDB.
    await Company.updateOne({ companyApiKey: companyApiKey }, { $push: { companyAdminIDDetails: { companyAdminName, companyAdminEmail, companyAdminPassword: hashedPassword } } });
    res.status(201).json({ message: 'Company admin registered successfully', companyAdminName, companyAdminEmail, companyAdminPassword: hashedPassword });
  } catch (error: any) {
    res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

// ✅ Working perfectly
// Company Admin Login endpoint (to login a company admin)
router.post('/company-admin/login', async (req: Request, res: Response) => {
  const companyApiKey = req.headers['your_company_api_key'] as string;
  try {
    const { companyAdminEmail, companyAdminPassword } = req.body;
    if (!companyAdminEmail || !companyAdminPassword || !companyApiKey) {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          companyAdminEmail: !companyAdminEmail ? 'Company admin email is required' : null,
          companyAdminPassword: !companyAdminPassword ? 'Company admin password is required' : null,
          companyApiKey: !companyApiKey ? 'Company API key is required in header (your_company_api_key)' : null
        }
      });
    }

    // Check if company exists and is verified by checking the API key in the header (your_company_api_key) in the Company model in the companyDB.
    const companyExists = await Company.findOne({ companyApiKey: companyApiKey });
    if (!companyExists || !companyExists.isVerified) {
      return res.status(401).json({ message: 'Invalid credentials', error: 'Company not found with this API key or company is not verified' });
    }
    // Checks if the company admin exists in the companyAdminIDDetails array in the Company model in the companyDB.
    const companyAdminExists = companyExists.companyAdminIDDetails.find((admin: { companyAdminEmail: string }) => admin.companyAdminEmail === companyAdminEmail);
    if (!companyAdminExists) {
      return res.status(401).json({ message: 'Invalid credentials', error: 'Company admin not found with this email' });
    }
    // Verifies the company admin password (supports bcrypt and scrypt hashed values)
    const isPasswordValid = await verifyPassword(companyAdminPassword, companyAdminExists.companyAdminPassword);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials', error: 'Incorrect password' });
    }
    // Generates JWT token
    const token = jwt.sign(
      {
        companyAdminId: companyExists.companyAdminIDDetails.findIndex((admin: { companyAdminEmail: string }) => admin.companyAdminEmail === companyAdminEmail),
        companyAdminEmail: companyAdminEmail,
        companyAdminName: companyAdminExists.companyAdminName
      } as JwtPayload,
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );
    res.status(200).json({ message: 'Login successful', token: token, companyAdmin: { companyAdminName: companyAdminExists.companyAdminName, companyAdminEmail: companyAdminExists.companyAdminEmail } });
  } catch (error: any) {
    res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
})

// ✅ Working perfectly
// Get all companies endpoint (to get all companies - Only Connect Fulfillment Admins can access this route)
router.get('/companies', verifyCFAdminToken, async (_req: Request, res: Response) => {
  // if (!req.body.company) return res.status(401).json({ message: 'Unauthorized' });
  const companyNames = await Company.find({}, 'companyName');
  res.status(200).json({ companyNames });
});

// ✅ Working perfectly
// verifies company admin token
router.get('/company-admin/verify-token', async (req: Request, res: Response) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized', error: 'No token provided' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    res.status(200).json({ message: 'Token verified', companyAdmin: { companyAdminName: decoded.companyAdminName, companyAdminEmail: decoded.companyAdminEmail } });
  } catch (error: any) {
    return res.status(401).json({ message: 'Unauthorized', error: 'Invalid token' });
  }
});

// ✅ Working perfectly
// Verifies if API key is valid or not
router.get('/verify-key', async (req: Request, res: Response) => {
  const apiKey = req.headers['your_company_api_key'] as string;
  if (!apiKey) return res.json({ valid: false, error: 'API key validation failed: Company API key is required' });

  const companyExist = await Company.findOne({ companyApiKey: apiKey });
  if (!companyExist) return res.json({ valid: false, error: 'API key validation failed: Invalid Company API key' });
  console.log('Company exists:', companyExist);
  res.json({ valid: true, company: companyExist });
});

// ✅ Working perfectly
// Add admin email to company admin emails
// Only Connect Fulfillment admins can add admin emails to companies
router.post('/add-admin-email-to-company', verifyCFAdminToken, async (req: Request, res: Response) => {
  try {
    const { newAdminEmail } = req.body;
    const companyApiKey = req.headers['company_to_add_admin_email_to'] as string;

    // Validation checks
    if (!newAdminEmail || !companyApiKey) {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          newAdminEmail: !newAdminEmail ? 'Admin email is required in request body' : null,
          companyApiKey: !companyApiKey ? 'Company API key is required in header (company_to_add_admin_email_to)' : null
        }
      });
    }

    // Validates email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newAdminEmail)) {
      return res.status(400).json({
        message: 'Invalid email format',
        error: 'Please enter a valid email address'
      });
    }

    // Finds company by API key (companyDB is already connected in company-service)
    const trimmedApiKey = companyApiKey.trim();
    console.log('Searching for company with API key:', trimmedApiKey);
    console.log('MongoDB connection state:', mongoose.connection.readyState === 1 ? 'connected' : 'not connected');
    console.log('Database name:', mongoose.connection.db?.databaseName);

    const company = await Company.findOne({ companyApiKey: trimmedApiKey });

    if (!company) {
      // Debug: Check if any companies exist
      const totalCount = await Company.countDocuments();
      console.log('Total companies in database:', totalCount);

      const allCompanies = await Company.find({}, 'companyName companyApiKey').limit(5);
      console.log('Sample companies in database:', allCompanies.map(c => ({
        name: c.companyName,
        apiKey: c.companyApiKey || 'null',
        fullApiKey: c.companyApiKey
      })));

      return res.status(404).json({
        message: 'Company not found',
        error: `No company with API key "${trimmedApiKey}" was found. Total companies: ${totalCount}. Please verify the API key is correct.`
      });
    }

    console.log('Company found:', company.companyName);

    // Check if email already exists in companyAdminEmails
    if (company.companyAdminEmails && company.companyAdminEmails.includes(newAdminEmail.toLowerCase())) {
      return res.status(409).json({
        message: 'Admin email already exists',
        error: 'This admin email is already added to the company'
      });
    }

    // Use findOneAndUpdate to add email to array without triggering full document validation
    // $addToSet ensures no duplicates and creates the array if it doesn't exist
    const updatedCompany = await Company.findOneAndUpdate(
      { companyApiKey: trimmedApiKey },
      {
        $addToSet: { companyAdminEmails: newAdminEmail.toLowerCase() }
      },
      {
        new: true, // Return updated document
        runValidators: false // Skip full document validation (only updates the array field)
      }
    );

    if (!updatedCompany) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Company was not found during update'
      });
    }

    return res.status(200).json({
      message: 'Admin email added to company admin emails successfully',
      company: {
        companyName: updatedCompany.companyName,
        companyEmail: updatedCompany.companyEmail
      }
    });
  } catch (error: any) {
    console.error('Error adding admin email to company:', error);
    return res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

export default router;

// {
//   "companyName": "Connect Fulfillment HQ",
//   "companyEmail": "connectfulfillment@connectfulfillment.com",
//   "companyAddress": "123 Connect Fulfillment St, Connect Fulfillment City, Connect Fulfillment Country",
//   "companyPhone": 2345678901,
//   "companyWebsite": "https://connectfulfillment.com",
//   "companyLogo": "https://connectfulfillment.com/logo.png",
//   "companyDescription": "Connect Fulfillment is a fulfillment center that stores and ships products to customers.",
//   "companyDetails": "Connect Fulfillment is a fulfillment center that stores and ships products to customers. We have a minimum of 100 products to offer and we have customers from all over the city.",
//   "companyCategory": "Other",
//   "companySubCategory": "Other",
// }

// {
//   "companyAdminName": "John Doe",
//   "companyAdminEmail": "john.doe@example.com",
//   "companyAdminPassword": "password123",
//   "companyApiKey": "CFK_1234567890"
// }