// This route is strictly for the companies to register itself in the system. They will be able to register themselves by providing their name, email, address, phone, website, logo, description, category, and sub-category as defined in the Company model.
import { Router } from 'express';
import { Request, Response } from 'express';
import { Company } from '../models/Company';
import crypto from 'crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import mongoose from 'mongoose';
import axios from 'axios';
import { verifyCFAdminToken } from '../middleware/verifyCFAdminToken';
import { verifyToken } from '../middleware/verifyToken';
import {
  publishCompanyAdminRemoved,
  publishCompanyApiKeyStatusChanged,
  publishCompanyStatusChanged,
  publishCompanyVerified
} from '../utils/kafkaPublisher';
// Attempt to use bcryptjs if available; fallback to crypto.scrypt otherwise
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bcrypt: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  bcrypt = require('bcryptjs');
} catch { }

/**
 * Verifies a plain text password against a hashed value.
 * Supports both bcrypt and scrypt hashing algorithms for backward compatibility.
 * 
 * @param {string} plainText - The plain text password to verify
 * @param {string} hashedValue - The hashed password (bcrypt or scrypt format)
 * @returns {Promise<boolean>} True if password matches, false otherwise
 */
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
const COMPANY_PORTAL_URL = (process.env.COMPANY_PORTAL_URL || 'https://portal.connectfulfillment.com').replace(/\/$/, '');

/**
 * Generates a secure random onboarding token for company API key retrieval.
 * Token is 48 bytes (96 hex characters) for high entropy.
 * 
 * @returns {string} Random hexadecimal token
 */
const generateOnboardingToken = () => crypto.randomBytes(48).toString('hex');

/**
 * Hashes an onboarding token using SHA-256 for secure storage.
 * The hashed value is stored in the database, not the plain token.
 * 
 * @param {string} token - The plain onboarding token to hash
 * @returns {string} SHA-256 hash of the token
 */
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Masks an API key for display purposes, showing only first and last few characters.
 * Used in emails and UI to prevent full API key exposure.
 * 
 * @param {string|null|undefined} apiKey - The API key to mask
 * @returns {string} Masked API key (e.g., "CFK_abcd••••wxyz")
 */
const maskApiKey = (apiKey?: string | null) => {
  if (!apiKey) return '***';
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}••${apiKey.slice(-2)}`;
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
};

/**
 * Builds the onboarding link URL for company API key retrieval.
 * Combines the company portal URL with the onboarding token.
 * 
 * @param {string} token - The onboarding token
 * @returns {string} Full onboarding URL with token parameter
 */
const buildOnboardingLink = (token: string) => `${COMPANY_PORTAL_URL}/setup?token=${token}`;

/**
 * Health check endpoint for the Company Service.
 * Returns a simple status message to confirm the service is running.
 * 
 * @route GET /
 * @returns {Object} Service status message
 */
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Company Service is running', service: 'company-service' });
});

/**
 * Register a new merchant company.
 * 
 * Creates a new company record with all required information. The company
 * is created with isVerified=false and must be verified by a CF Admin before
 * they can use the API. An API key is automatically generated and assigned.
 * 
 * @route POST /register
 * @access Public (no authentication required)
 * 
 * @param {string} req.body.companyName - Company name
 * @param {string} req.body.companyEmail - Company email (must be unique)
 * @param {string} req.body.companyAddress - Company physical address
 * @param {number} req.body.companyPhone - Company phone number (10 digits, must be unique)
 * @param {string} req.body.companyWebsite - Company website URL
 * @param {string} req.body.companyLogo - Company logo URL (image URL)
 * @param {string} req.body.companyDescription - Company description (10-1000 chars)
 * @param {string} req.body.companyDetails - Detailed company information (100-1000 chars)
 * @param {string} req.body.companyCategory - Company category (Electronics, Clothing, Furniture, Other)
 * @param {string} req.body.companySubCategory - Company sub-category
 * 
 * @returns {Object} 201 - Company registered successfully (API key not included in response)
 * @returns {Object} 400 - Validation error (missing fields, invalid format)
 * @returns {Object} 409 - Company email or phone already exists
 */
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
    const { companyName, companyEmail, companyAddress, companyPhone, companyWebsite, companyLogo, companyDescription, companyDetails, companyCategory, companySubCategory } = req.body;
    
    // Force isVerified to false - companies cannot self-verify
    // Only CF Admins can verify companies via PATCH /company/:companyId/verify

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

    // Create company with isVerified=false (default from schema, but explicitly set for clarity)
    const company = await Company.create({ 
      companyName, 
      companyEmail, 
      companyAddress, 
      companyPhone, 
      companyWebsite, 
      companyLogo, 
      companyDescription, 
      companyDetails, 
      companyCategory, 
      companySubCategory, 
      companyApiKey,
      isVerified: false // Always false on registration!😤
    });

    const companySafe = company.toObject();
    delete (companySafe as any).companyApiKey;
    res.status(201).json({ message: 'Company registered successfully', company: companySafe });
  } catch (error: any) {
    res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
})

/**
 * Register a company admin for a merchant company.
 * 
 * Creates a company admin account linked to a specific company. The admin
 * email must first be added to the company's admin emails list by a CF Admin.
 * The company must be verified before admins can register.
 * 
 * @route POST /company-admin/register
 * @access Public (but requires company API key in header)
 * 
 * @param {string} req.headers.your_company_api_key - Company API key (required)
 * @param {string} req.body.companyAdminName - Full name of the company admin
 * @param {string} req.body.companyAdminEmail - Email address (must be in company's admin emails list)
 * @param {string} req.body.companyAdminPassword - Password for the admin account
 * 
 * @returns {Object} 201 - Company admin registered successfully
 * @returns {Object} 400 - Validation error (missing fields)
 * @returns {Object} 401 - Company not found or not verified
 * @returns {Object} 409 - Admin email not linked to company or admin already exists
 */
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

/**
 * Login endpoint for company admins.
 * 
 * Authenticates a company admin using email, password, and company API key.
 * Returns a JWT token that includes company information for authorization.
 * The company must be verified and active for login to succeed.
 * 
 * @route POST /company-admin/login
 * @access Public (but requires company API key in header)
 * 
 * @param {string} req.headers.your_company_api_key - Company API key (required)
 * @param {string} req.body.companyAdminEmail - Company admin email
 * @param {string} req.body.companyAdminPassword - Company admin password
 * 
 * @returns {Object} 200 - Login successful with JWT token and admin details
 * @returns {Object} 400 - Validation error (missing fields)
 * @returns {Object} 401 - Invalid credentials (company not found, not verified, or incorrect password)
 */
router.post('/company-admin/login', async (req: Request, res: Response) => {
  const companyApiKey = req.headers['your_company_api_key'] as string;
  const startTime = Date.now();
  
  try {
    console.log(`[Login] Starting login attempt for API key: ${companyApiKey?.substring(0, 10)}...`);
    
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
    console.log(`[Login] Querying database for company with API key...`);
    const dbQueryStart = Date.now();
    
    // Add maxTimeMS to prevent queries from hanging indefinitely
    const companyExists = await Company.findOne({ companyApiKey: companyApiKey })
      .maxTimeMS(10000) // 10 second timeout for the query
      .lean()
      .exec();
    
    console.log(`[Login] Database query took ${Date.now() - dbQueryStart}ms`);
    
    if (!companyExists || !companyExists.isVerified) {
      console.log(`[Login] Company not found or not verified`);
      return res.status(401).json({ message: 'Invalid credentials', error: 'Company not found with this API key or company is not verified' });
    }
    
    console.log(`[Login] Company found: ${companyExists.companyName}`);
    
    // Checks if the company admin exists in the companyAdminIDDetails array in the Company model in the companyDB.
    const passwordCheckStart = Date.now();
    const companyAdminExists = (companyExists.companyAdminIDDetails || []).find(
      (admin: { companyAdminEmail: string }) => admin.companyAdminEmail.toLowerCase() === companyAdminEmail.toLowerCase()
    );
    
    if (!companyAdminExists) {
      console.log(`[Login] Admin not found for email: ${companyAdminEmail}`);
      return res.status(401).json({ message: 'Invalid credentials', error: 'Company admin not found with this email' });
    }
    
    console.log(`[Login] Admin found, verifying password...`);
    
    // Verifies the company admin password (supports bcrypt and scrypt hashed values)
    const isPasswordValid = await verifyPassword(companyAdminPassword, companyAdminExists.companyAdminPassword);
    console.log(`[Login] Password verification took ${Date.now() - passwordCheckStart}ms`);
    
    if (!isPasswordValid) {
      console.log(`[Login] Invalid password`);
      return res.status(401).json({ message: 'Invalid credentials', error: 'Incorrect password' });
    }
    
    console.log(`[Login] Password valid, generating token...`);
    
    // Generates JWT token with company information
    const token = jwt.sign(
      {
        companyAdminId: (companyExists.companyAdminIDDetails || []).findIndex(
          (admin: { companyAdminEmail: string }) => admin.companyAdminEmail.toLowerCase() === companyAdminEmail.toLowerCase()
        ),
        companyAdminEmail: companyAdminEmail.toLowerCase(),
        companyAdminName: companyAdminExists.companyAdminName,
        companyId: companyExists._id.toString(),
        companyApiKey: companyExists.companyApiKey,
        companyName: companyExists.companyName
      } as JwtPayload,
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );
    
    console.log(`[Login] Login successful in ${Date.now() - startTime}ms`);
    
    res.status(200).json({ 
      message: 'Login successful', 
      token: token, 
      companyAdmin: { 
        companyAdminName: companyAdminExists.companyAdminName, 
        companyAdminEmail: companyAdminExists.companyAdminEmail 
      } 
    });
  } catch (error: any) {
    console.error(`[Login] Error after ${Date.now() - startTime}ms:`, error);
    if (!res.headersSent) {
      res.status(500).json({ 
        message: 'Internal server error', 
        error: error?.message || 'An unknown error occurred' 
      });
    }
  }
})

/**
 * Get all registered companies (CF Admin only).
 * 
 * Returns a list of all company names in the system. Only CF Admins can
 * access this endpoint. For full company details, use other admin endpoints.
 * 
 * @route GET /companies
 * @access Private (requires CF Admin JWT token)
 * 
 * @returns {Object} 200 - List of all company names
 */
router.get('/companies', verifyCFAdminToken, async (_req: Request, res: Response) => {
  // if (!req.body.company) return res.status(401).json({ message: 'Unauthorized' });
  const companyNames = await Company.find({}, 'companyName');
  res.status(200).json({ companyNames });
});

/**
 * Get companies with order deletion settings enabled (Internal service endpoint).
 * 
 * Returns a list of companies that have configured automatic order deletion.
 * Used by the order-service scheduler to determine which companies' orders
 * should be auto-deleted based on their retention settings. Only returns
 * verified and active companies.
 * 
 * @route GET /companies-with-deletion-settings
 * @access Internal (requires INTERNAL_SERVICE_TOKEN, optional for backward compatibility)
 * 
 * @returns {Object} 200 - List of companies with deletion settings and their configuration
 * @returns {Object} 401 - Unauthorized (invalid internal service token)
 */
router.get('/companies-with-deletion-settings', async (req: Request, res: Response) => {
  try {
    // Verify internal service token if provided (optional for backward compatibility)
    const internalToken = req.headers['x-internal-token'] || 
                          req.headers['authorization']?.replace(/Bearer\s+/i, '') ||
                          req.headers['x-service-secret'];
    const expectedToken = process.env.INTERNAL_SERVICE_TOKEN;

    if (expectedToken && internalToken !== expectedToken) {
      return res.status(401).json({
        message: 'Unauthorized',
        error: 'Internal service token required'
      });
    }

    // Find companies with deletion settings enabled
    const companies = await Company.find({
      'orderDeletionSettings.enabled': true,
      isVerified: true, // Only verified companies
      isActive: true, // Only active companies
    }).select('_id companyName companyEmail orderDeletionSettings').lean();

    res.status(200).json({
      message: 'Companies with deletion settings retrieved successfully',
      companies: companies.map(company => ({
        _id: company._id,
        companyName: company.companyName,
        companyEmail: company.companyEmail,
        orderDeletionSettings: company.orderDeletionSettings,
      })),
      count: companies.length,
    });
  } catch (error: any) {
    console.error('Error fetching companies with deletion settings:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Verify a company admin JWT token.
 * 
 * Validates a company admin token and returns the admin information if valid.
 * Useful for frontend token validation and session checks.
 * 
 * @route GET /company-admin/verify-token
 * @access Public (but requires valid JWT token)
 * 
 * @param {string} req.headers.authorization - Bearer token (JWT)
 * 
 * @returns {Object} 200 - Token verified with admin details
 * @returns {Object} 401 - Invalid or expired token
 */
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

/**
 * Verify if a company API key is valid.
 * 
 * Used by the API Gateway to validate API keys on each request. Returns
 * company information if the key is valid and the company is verified/active.
 * This is a critical security endpoint for API access control.
 * 
 * @route GET /verify-key
 * @access Public (but requires API key in header)
 * 
 * @param {string} req.headers.your_company_api_key - Company API key to verify
 * 
 * @returns {Object} 200 - API key validation result with company details if valid
 * @returns {Object} 200 - API key validation result with valid: false if invalid
 */
router.get('/verify-key', async (req: Request, res: Response) => {
  const apiKey = req.headers['your_company_api_key'] as string;
  if (!apiKey) return res.json({ valid: false, error: 'API key validation failed: Company API key is required' });

  const companyExist = await Company.findOne({ companyApiKey: apiKey });
  if (!companyExist) return res.json({ valid: false, error: 'API key validation failed: Invalid Company API key' });
  console.log('Company exists:', companyExist);
  res.json({ valid: true, company: companyExist });
});

/**
 * Add an admin email to a company's admin emails list.
 * 
 * Adds an email address to the company's authorized admin emails. This email
 * can then be used to register as a company admin. Only CF Admins can perform
 * this action to maintain control over company admin access.
 * 
 * @route POST /add-admin-email-to-company
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.headers.company_to_add_admin_email_to - Company API key
 * @param {string} req.body.newAdminEmail - Email address to add to company admin emails
 * 
 * @returns {Object} 200 - Admin email added successfully
 * @returns {Object} 400 - Validation error (missing fields, invalid email format)
 * @returns {Object} 404 - Company not found
 * @returns {Object} 409 - Admin email already exists in company
 */
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

/**
 * Verify or unverify a company and manage onboarding tokens.
 * 
 * Allows CF Admins to verify companies (enabling API access) or unverify them.
 * When verifying, generates a one-time onboarding token and link for secure
 * API key retrieval. The token expires in 24 hours and can only be used once.
 * Publishes company_verified event to Kafka when verification is enabled.
 * 
 * @route PATCH /company/:companyId/verify
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.params.companyId - MongoDB ObjectId of the company
 * @param {boolean} req.body.isVerified - Whether to verify (true) or unverify (false) the company
 * @param {boolean} [req.body.regenerateToken] - Whether to regenerate onboarding token even if already verified
 * 
 * @returns {Object} 200 - Company verification status updated with onboarding link if verified
 * @returns {Object} 400 - Validation error (isVerified must be boolean)
 * @returns {Object} 404 - Company not found
 */
router.patch('/company/:companyId/verify', verifyCFAdminToken, async (req: Request, res: Response) => {
  try {
    const { isVerified, regenerateToken } = req.body;
    if (typeof isVerified !== 'boolean') {
      return res.status(400).json({ message: 'isVerified field is required and must be boolean' });
    }

    const company = await Company.findById(req.params.companyId).select('+onboardingTokenHash');
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const wasVerified = company.isVerified;
    company.isVerified = isVerified;
    let onboardingLink: string | null = null;
    let tokenAssigned = false;

    if (isVerified) {
      if (!wasVerified || regenerateToken) {
        const onboardingToken = generateOnboardingToken();
        company.onboardingTokenHash = hashToken(onboardingToken);
        company.onboardingTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        company.onboardingTokenUsedAt = null;
        onboardingLink = buildOnboardingLink(onboardingToken);
        tokenAssigned = true;
      }
    } else {
      company.onboardingTokenHash = null;
      company.onboardingTokenExpiresAt = null;
      company.onboardingTokenUsedAt = null;
    }

    await company.save();

    if (isVerified && tokenAssigned && onboardingLink) {
      await publishCompanyVerified({
        companyId: company._id.toString(),
        companyName: company.companyName,
        companyEmail: company.companyEmail,
        onboardingLink,
        apiKeyMasked: maskApiKey(company.companyApiKey)
      });
    }

    return res.status(200).json({
      message: `Company verification updated to ${isVerified}`,
      company: {
        id: company._id,
        companyName: company.companyName,
        isVerified: company.isVerified,
        apiKeyMasked: maskApiKey(company.companyApiKey),
        onboardingTokenExpiresAt: company.onboardingTokenExpiresAt
      }
    });
  } catch (error: any) {
    console.error('Error updating company verification:', error);
    return res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

/**
 * Toggle API key status (active/inactive) for a company.
 * 
 * Allows CF Admins to temporarily disable a company's API key without
 * unverifying the company. When status changes, publishes company_api_key_status_changed
 * event to Kafka to notify the company.
 * 
 * @route PATCH /company/:companyId/api-key/status
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.params.companyId - MongoDB ObjectId of the company
 * @param {boolean} req.body.active - Whether to activate (true) or deactivate (false) the API key
 * 
 * @returns {Object} 200 - API key status updated successfully
 * @returns {Object} 400 - Validation error (active must be boolean)
 * @returns {Object} 404 - Company not found
 */
router.patch('/company/:companyId/api-key/status', verifyCFAdminToken, async (req: Request, res: Response) => {
  try {
    const { active } = req.body;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ message: 'active field is required and must be boolean' });
    }
    const company = await Company.findById(req.params.companyId);
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }
    const previous = company.apiKeyActive;
    company.apiKeyActive = active;
    await company.save();

    if (previous !== active) {
      await publishCompanyApiKeyStatusChanged({
        companyId: company._id.toString(),
        companyName: company.companyName,
        companyEmail: company.companyEmail,
        status: active ? 'active' : 'inactive',
        changerEmail: req.body.adminEmail
      });
    }

    return res.status(200).json({
      message: `Company API key status updated to ${active ? 'active' : 'inactive'}`,
      company: {
        id: company._id,
        companyName: company.companyName,
        apiKeyActive: company.apiKeyActive
      }
    });
  } catch (error: any) {
    console.error('Error updating API key status:', error);
    return res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

/**
 * Activate or deactivate a merchant company account.
 * 
 * Allows CF Admins to suspend or reactivate a company's account. When status
 * changes, publishes company_status_changed event to Kafka to notify the company.
 * Deactivated companies cannot use the API even if verified.
 * 
 * @route PATCH /company/:companyId/status
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.params.companyId - MongoDB ObjectId of the company
 * @param {boolean} req.body.isActive - Whether to activate (true) or deactivate (false) the account
 * @param {string} [req.body.reason] - Optional reason for status change
 * 
 * @returns {Object} 200 - Company status updated successfully
 * @returns {Object} 400 - Validation error (isActive must be boolean)
 * @returns {Object} 404 - Company not found
 */
router.patch('/company/:companyId/status', verifyCFAdminToken, async (req: Request, res: Response) => {
  try {
    const { isActive, reason } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive field is required and must be boolean' });
    }
    const company = await Company.findById(req.params.companyId);
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }
    const previous = company.isActive;
    company.isActive = isActive;
    await company.save();

    if (previous !== isActive) {
      await publishCompanyStatusChanged({
        companyId: company._id.toString(),
        companyName: company.companyName,
        companyEmail: company.companyEmail,
        isActive,
        reason,
        changedBy: req.body.adminEmail
      });
    }

    return res.status(200).json({
      message: `Company status updated to ${isActive ? 'active' : 'inactive'}`,
      company: {
        id: company._id,
        companyName: company.companyName,
        isActive: company.isActive
      }
    });
  } catch (error: any) {
    console.error('Error updating company status:', error);
    return res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

/**
 * Remove a company admin from a merchant company.
 * 
 * Removes a company admin from both the companyAdminIDDetails array and the
 * companyAdminEmails array. Publishes company_admin_removed event to Kafka
 * to notify the removed admin. Only CF Admins can perform this action.
 * 
 * @route DELETE /company/company-admin
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.body.companyId - MongoDB ObjectId of the company
 * @param {string} req.body.companyAdminEmail - Email of the admin to remove
 * 
 * @returns {Object} 200 - Company admin removed successfully
 * @returns {Object} 400 - Validation error (missing fields)
 * @returns {Object} 404 - Company or admin not found
 */
router.delete('/company/company-admin', verifyCFAdminToken, async (req: Request, res: Response) => {
  try {
    const { companyId, companyAdminEmail } = req.body;
    if (!companyId || !companyAdminEmail) {
      return res.status(400).json({ message: 'companyId and companyAdminEmail are required' });
    }
    const normalizedEmail = (companyAdminEmail as string).toLowerCase();
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const adminIndex = (company.companyAdminIDDetails || []).findIndex(
      (admin: { companyAdminEmail: string }) => admin.companyAdminEmail?.toLowerCase() === normalizedEmail
    );
    if (adminIndex === -1) {
      return res.status(404).json({ message: 'Company admin not found on this company' });
    }

    company.companyAdminIDDetails.splice(adminIndex, 1);
    company.companyAdminEmails = (company.companyAdminEmails || []).filter(email => email.toLowerCase() !== normalizedEmail);
    await company.save();

    await publishCompanyAdminRemoved({
      companyId: company._id.toString(),
      companyName: company.companyName,
      companyEmail: company.companyEmail,
      adminEmail: normalizedEmail,
      removedBy: {
        adminEmail: req.body.adminEmail,
        adminName: req.body.adminName
      }
    });

    return res.status(200).json({
      message: 'Company admin removed successfully',
      company: {
        id: company._id,
        companyName: company.companyName,
        remainingAdmins: company.companyAdminEmails?.length || 0
      }
    });
  } catch (error: any) {
    console.error('Error removing company admin:', error);
    return res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

/**
 * Redeem onboarding token to retrieve company API key (one-time use).
 * 
 * Allows companies to securely retrieve their API key using the onboarding
 * token sent via email after verification. The token can only be used once
 * and expires after 24 hours. After redemption, the token is invalidated.
 * 
 * @route GET /company/onboarding/:token
 * @access Public (but requires valid onboarding token)
 * 
 * @param {string} req.params.token - The onboarding token from the verification email
 * 
 * @returns {Object} 200 - API key retrieved successfully (only time it's shown in plain text)
 * @returns {Object} 400 - Token is required
 * @returns {Object} 404 - Invalid token
 * @returns {Object} 410 - Token expired or already used
 * @returns {Object} 409 - Company API key not found
 */
router.get('/company/onboarding/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ message: 'Token is required' });
    }
    const tokenHash = hashToken(token);
    const company = await Company.findOne({ onboardingTokenHash: tokenHash }).select('+onboardingTokenHash');
    if (!company) {
      return res.status(404).json({ message: 'Invalid or expired token' });
    }
    if (!company.onboardingTokenExpiresAt || company.onboardingTokenExpiresAt.getTime() < Date.now()) {
      return res.status(410).json({ message: 'Token has expired. Please request a new onboarding link.' });
    }
    if (company.onboardingTokenUsedAt) {
      return res.status(410).json({ message: 'This token has already been used.' });
    }
    if (!company.companyApiKey) {
      return res.status(409).json({ message: 'Company API key not found. Please contact support.' });
    }

    company.onboardingTokenHash = null;
    company.onboardingTokenUsedAt = new Date();
    await company.save();

    return res.status(200).json({
      message: 'API key retrieved successfully. Store it securely because you will not be able to view it again.',
      company: {
        id: company._id,
        companyName: company.companyName,
        companyEmail: company.companyEmail
      },
      apiKey: company.companyApiKey
    });
  } catch (error: any) {
    console.error('Error redeeming onboarding token:', error);
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