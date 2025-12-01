// This route is strictly for the companies to register itself in the system. They will be able to register themselves by providing their name, email, address, phone, website, logo, description, category, and sub-category as defined in the Company model.
import { Router, Request, Response, CookieOptions } from 'express';
import { Company } from '../models/Company';
import { CompanyAdmin } from '../models/CompanyAdmin';
import { CompanyAdminSession } from '../models/CompanyAdminSession';
import crypto from 'crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import mongoose from 'mongoose';
import axios from 'axios';
import { verifyCFAdminToken } from '../middleware/verifyCFAdminToken';
import { verifyToken } from '../middleware/verifyToken';
import { verifyCompanyAdminToken } from '../middleware/verifyCompanyAdminToken';
import {
  publishMerchantAdminRegistered,
  publishCompanyAdminRemoved,
  publishCompanyApiKeyStatusChanged,
  publishCompanyStatusChanged,
  publishCompanyVerified
} from '../utils/kafkaPublisher';
import { createAuditLog, extractUserInfo } from '../utils/auditLogger';
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

/**
 * Validates password strength requirements.
 * Password must contain: at least 8 characters, one uppercase letter, one lowercase letter,
 * one number, and one special character (@$!%*?&).
 * 
 * @param {string} password - The password to validate
 * @returns {boolean} True if password meets strength requirements, false otherwise
 */
const isValidPassword = (password: string): boolean => {
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  return passwordRegex.test(password);
};

const toPositiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const ACCESS_TOKEN_COOKIE_NAME = process.env.COMPANY_ADMIN_ACCESS_COOKIE_NAME || 'ffm_access';
const REFRESH_TOKEN_COOKIE_NAME = process.env.COMPANY_ADMIN_REFRESH_COOKIE_NAME || 'ffm_refresh';
const ACCESS_TOKEN_TTL_MINUTES = toPositiveNumber(process.env.COMPANY_ADMIN_ACCESS_TOKEN_MINUTES, 15);
const REFRESH_TOKEN_TTL_DAYS = toPositiveNumber(process.env.COMPANY_ADMIN_REFRESH_TOKEN_DAYS, 7);
const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_MINUTES * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_EXPIRES_IN_SECONDS = ACCESS_TOKEN_TTL_MINUTES * 60;

const cookieBaseOptions: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  domain: process.env.COMPANY_ADMIN_COOKIE_DOMAIN || undefined,
  path: '/',
};

const createRefreshToken = () => crypto.randomBytes(64).toString('hex');
const hashRefreshToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const rawCompanyJwtSecret = process.env.JWT_SECRET;
if (!rawCompanyJwtSecret) {
  throw new Error('JWT_SECRET environment variable is required for company-service to issue merchant admin tokens.');
}
const COMPANY_JWT_SECRET: string = rawCompanyJwtSecret;

const setAuthCookies = (res: Response, accessToken: string, refreshToken: string) => {
  res.cookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, {
    ...cookieBaseOptions,
    maxAge: ACCESS_TOKEN_TTL_MS,
  });
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, {
    ...cookieBaseOptions,
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
};

const clearAuthCookies = (res: Response) => {
  const clearOptions: CookieOptions = { ...cookieBaseOptions, maxAge: 0 };
  res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, clearOptions);
  res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, clearOptions);
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
 * @returns {string} Masked API key (e.g., "FFM_abcd••••wxyz")
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
    const { companyName, companyEmail, companyAddress, companyPhone, companyWebsite, companyLogo, companyDescription, companyDetails, companyCategory, companySubCategory, deliveryTimeHours, serviceSchedule, orderDeletionSettings } = req.body;

    // Validate deliveryTimeHours if provided
    if (deliveryTimeHours !== undefined) {
      if (typeof deliveryTimeHours !== 'number' || deliveryTimeHours < 0.5 || deliveryTimeHours > 168) {
        return res.status(400).json({
          message: 'Validation error',
          error: 'deliveryTimeHours must be a number between 0.5 and 168 (hours)'
        });
      }
    }

    // Validate serviceSchedule if provided
    if (serviceSchedule) {
      if (serviceSchedule.enabled !== undefined && typeof serviceSchedule.enabled !== 'boolean') {
        return res.status(400).json({
          message: 'Validation error',
          error: 'serviceSchedule.enabled must be a boolean'
        });
      }

      if (serviceSchedule.schedule) {
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

        for (const day of days) {
          if (serviceSchedule.schedule[day]) {
            const daySchedule = serviceSchedule.schedule[day];

            if (daySchedule.enabled !== undefined && typeof daySchedule.enabled !== 'boolean') {
              return res.status(400).json({
                message: 'Validation error',
                error: `serviceSchedule.schedule.${day}.enabled must be a boolean`
              });
            }

            if (daySchedule.startTime && !timeRegex.test(daySchedule.startTime)) {
              return res.status(400).json({
                message: 'Validation error',
                error: `serviceSchedule.schedule.${day}.startTime must be in HH:mm format (24-hour)`
              });
            }

            if (daySchedule.endTime && !timeRegex.test(daySchedule.endTime)) {
              return res.status(400).json({
                message: 'Validation error',
                error: `serviceSchedule.schedule.${day}.endTime must be in HH:mm format (24-hour)`
              });
            }

            if (daySchedule.startTime && daySchedule.endTime) {
              const [startHour, startMin] = daySchedule.startTime.split(':').map(Number);
              const [endHour, endMin] = daySchedule.endTime.split(':').map(Number);
              const startMinutes = startHour * 60 + startMin;
              const endMinutes = endHour * 60 + endMin;

              if (endMinutes <= startMinutes) {
                return res.status(400).json({
                  message: 'Validation error',
                  error: `serviceSchedule.schedule.${day}.endTime must be after startTime`
                });
              }
            }
          }
        }
      }
    }

    // Validate orderDeletionSettings if provided
    if (orderDeletionSettings) {
      if (orderDeletionSettings.enabled !== undefined && typeof orderDeletionSettings.enabled !== 'boolean') {
        return res.status(400).json({
          message: 'Validation error',
          error: 'orderDeletionSettings.enabled must be a boolean'
        });
      }

      if (orderDeletionSettings.daysToDelete !== undefined) {
        if (typeof orderDeletionSettings.daysToDelete !== 'number' || orderDeletionSettings.daysToDelete < 1 || !Number.isInteger(orderDeletionSettings.daysToDelete)) {
          return res.status(400).json({
            message: 'Validation error',
            error: 'orderDeletionSettings.daysToDelete must be an integer greater than or equal to 1'
          });
        }
      }

      if (orderDeletionSettings.deletionTime !== undefined) {
        const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
        if (!timeRegex.test(orderDeletionSettings.deletionTime)) {
          return res.status(400).json({
            message: 'Validation error',
            error: 'orderDeletionSettings.deletionTime must be in HH:mm format (24-hour), e.g., "21:00"'
          });
        }
      }
    }

    // Force isVerified to false - companies cannot self-verify
    // Only CF Admins can verify companies via PATCH /company/:companyId/verify

    // Generates strong random API key
    const generateApiKey = () => `FFM_${crypto.randomBytes(48).toString('base64url')}`; // ~64 chars

    // Ensure unlikely collision is handled
    let companyApiKey = generateApiKey();
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await Company.findOne({ companyApiKey });
      if (!exists) break;
      companyApiKey = generateApiKey();
    }

    // Prepare company data
    const companyData: any = {
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
      isVerified: false, // Always false on registration!😤
      deliveryTimeHours: deliveryTimeHours || 2 // Default to 2 hours if not provided
    };

    // Add optional serviceSchedule if provided
    if (serviceSchedule) {
      companyData.serviceSchedule = serviceSchedule;
    }

    // Add optional orderDeletionSettings if provided
    if (orderDeletionSettings) {
      companyData.orderDeletionSettings = orderDeletionSettings;
    }

    // Create company with isVerified=false (default from schema, but explicitly set for clarity)
    const company = await Company.create(companyData);

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
 * The system automatically finds the company by checking if the email is in
 * the company's admin emails list. The company must be verified before admins can register.
 * 
 * @route POST /company-admin/register
 * @access Public
 * 
 * @param {string} req.body.companyAdminName - Full name of the company admin (required)
 * @param {string} req.body.companyAdminEmail - Email address (must be in company's admin emails list) (required)
 * @param {string} req.body.companyAdminPassword - Password for the admin account (required)
 * 
 * @returns {Object} 201 - Company admin registered successfully
 * @returns {Object} 400 - Validation error (missing fields)
 * @returns {Object} 401 - Company not verified
 * @returns {Object} 404 - Company not found (email not in any company's admin emails list)
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
          companyAdminPassword: !req.body.companyAdminPassword ? 'Company admin password is required' : null
        }
      });
    }
    const { companyAdminName, companyAdminEmail, companyAdminPassword } = req.body;

    // Find company by checking if the admin email is in the companyAdminEmails array
    // This allows registration without requiring the API key in the header
    const companyExists = await Company.findOne({
      companyAdminEmails: { $regex: new RegExp(`^${companyAdminEmail.toLowerCase()}$`, 'i') }
    });

    if (!companyExists) {
      return res.status(404).json({ message: 'Company not found', error: 'No company found with this admin email. Please contact your company administrator to add your email to the company admin list.' });
    }

    if (!companyExists.isVerified) {
      return res.status(401).json({ message: 'Company not verified', error: 'Company is not verified. Please wait for verification before registering.' });
    }

    // Checks if the admin email is linked to this company by checking the companyAdminEmails array in the Company model in the companyDB.
    const adminEmailListed = (companyExists.companyAdminEmails || []).some(
      (email: string) => email.toLowerCase() === companyAdminEmail.toLowerCase()
    );
    if (!adminEmailListed) {
      return res.status(409).json({ message: 'Admin not linked to this company', error: 'Company admin is not linked to this company' });
    }

    // Checks if the admin already exists in the companyAdminIDDetails array in the Company model in the companyDB.
    const adminAlreadyExists = companyExists.companyAdminIDDetails.find(
      (admin: { companyAdminEmail: string }) => admin.companyAdminEmail.toLowerCase() === companyAdminEmail.toLowerCase()
    );

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
    await Company.updateOne(
      { _id: companyExists._id },
      { $push: { companyAdminIDDetails: { companyAdminName, companyAdminEmail, companyAdminPassword: hashedPassword } } }
    );

    // Also create a document in the CompanyAdmin collection for easy querying across all companies
    // Check if admin already exists in CompanyAdmin collection (shouldn't happen, but safety check)
    const existingAdminInCollection = await CompanyAdmin.findOne({
      companyAdminEmail: companyAdminEmail.toLowerCase()
    });

    if (!existingAdminInCollection) {
      await CompanyAdmin.create({
        companyId: companyExists._id.toString(),
        companyName: companyExists.companyName,
        companyAdminName,
        companyAdminEmail: companyAdminEmail.toLowerCase(),
        companyAdminPassword: hashedPassword
      });
    }

    // Create audit log
    await createAuditLog({
      action: 'company_admin_registered',
      performedBy: companyExists.companyName,
      performedByRole: 'merchant_admin',
      performedById: companyExists._id.toString(),
      performedByName: companyExists.companyName,
      targetCompany: companyExists._id.toString(),
      targetCompanyName: companyExists.companyName,
      targetAdmin: companyAdminEmail,
      details: {
        adminName: companyAdminName,
        adminEmail: companyAdminEmail,
      },
      service: 'company-service',
    }, req);

    // Send welcome email notification
    try {
      await publishMerchantAdminRegistered({
        companyId: companyExists._id.toString(),
        companyName: companyExists.companyName,
        companyEmail: companyExists.companyEmail,
        adminEmail: companyAdminEmail,
        adminName: companyAdminName,
        loginUrl: `${COMPANY_PORTAL_URL}/login`,
      });
      console.log(`✅ Published merchant_admin_registered event for ${companyAdminEmail}`);
    } catch (error: any) {
      // Log error but don't fail registration if email notification fails
      console.error(`⚠️ Failed to publish merchant_admin_registered event:`, error?.message || error);
    }

    res.status(201).json({ message: 'Company admin registered successfully', companyAdminName, companyAdminEmail, companyAdminPassword: hashedPassword });
  } catch (error: any) {
    res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

/**
 * Login endpoint for company admins.
 * 
 * Authenticates a company admin using email and password only.
 * The system automatically finds the company associated with the admin email.
 * Returns a JWT token that includes company information (including API key) for authorization.
 * The company must be verified and active for login to succeed.
 * 
 * @route POST /company-admin/login
 * @access Public
 * 
 * @param {string} req.body.companyAdminEmail - Company admin email (required)
 * @param {string} req.body.companyAdminPassword - Company admin password (required)
 * 
 * @returns {Object} 200 - Login successful with JWT token and admin details
 * @returns {Object} 400 - Validation error (missing fields)
 * @returns {Object} 401 - Invalid credentials (company admin not found, company not verified, or incorrect password)
 */
router.post('/company-admin/login', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const { companyAdminEmail, companyAdminPassword } = req.body;
    if (!companyAdminEmail || !companyAdminPassword) {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          companyAdminEmail: !companyAdminEmail ? 'Company admin email is required' : null,
          companyAdminPassword: !companyAdminPassword ? 'Company admin password is required' : null
        }
      });
    }

    // Log high-level event only – avoid logging PII like email or password
    console.log('[Login] Starting login attempt');

    // Find company by searching for the admin email in companyAdminIDDetails array
    console.log('[Login] Querying database for company with admin email...');
    const dbQueryStart = Date.now();

    // Search for company that has this admin email in companyAdminIDDetails
    const companyExists = await Company.findOne({
      'companyAdminIDDetails.companyAdminEmail': { $regex: new RegExp(`^${companyAdminEmail.toLowerCase()}$`, 'i') }
    })
      .maxTimeMS(10000) // 10 second timeout for the query
      .lean()
      .exec();

    console.log(`[Login] Database query took ${Date.now() - dbQueryStart}ms`);

    if (!companyExists) {
      console.log('[Login] Company not found for provided admin email');
      return res.status(401).json({ message: 'Invalid credentials', error: 'Company admin not found with this email' });
    }

    if (!companyExists.isVerified) {
      console.log('[Login] Company not verified');
      return res.status(401).json({ message: 'Invalid credentials', error: 'Company is not verified' });
    }

    console.log('[Login] Company found for admin email');

    // Checks if the company admin exists in the companyAdminIDDetails array in the Company model in the companyDB.
    const passwordCheckStart = Date.now();
    const companyAdminExists = (companyExists.companyAdminIDDetails || []).find(
      (admin: { companyAdminEmail: string }) => admin.companyAdminEmail.toLowerCase() === companyAdminEmail.toLowerCase()
    );

    if (!companyAdminExists) {
      console.log('[Login] Admin not found for provided email');
      return res.status(401).json({ message: 'Invalid credentials', error: 'Company admin not found with this email' });
    }

    console.log('[Login] Admin found, verifying password...');

    // Verifies the company admin password (supports bcrypt and scrypt hashed values)
    const isPasswordValid = await verifyPassword(companyAdminPassword, companyAdminExists.companyAdminPassword);
    console.log(`[Login] Password verification took ${Date.now() - passwordCheckStart}ms`);

    if (!isPasswordValid) {
      console.log('[Login] Invalid password');
      return res.status(401).json({ message: 'Invalid credentials', error: 'Incorrect password' });
    }

    console.log('[Login] Password valid, generating token...');

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
      COMPANY_JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS }
    );

    const refreshToken = createRefreshToken();
    await CompanyAdminSession.create({
      companyAdminEmail: companyAdminExists.companyAdminEmail.toLowerCase(),
      companyAdminName: companyAdminExists.companyAdminName,
      companyId: companyExists._id.toString(),
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    setAuthCookies(res, token, refreshToken);

    console.log(`[Login] Login successful in ${Date.now() - startTime}ms`);
    console.log('[Login] Merchant admin session issued', {
      companyName: companyExists.companyName,
      companyAdminName: companyAdminExists.companyAdminName,
      companyAdminEmail: companyAdminExists.companyAdminEmail.toLowerCase(),
    });

    // Create audit log
    await createAuditLog({
      action: 'login',
      performedBy: companyAdminExists.companyAdminEmail.toLowerCase(),
      performedByRole: 'merchant_admin',
      performedById: (companyExists.companyAdminIDDetails || []).findIndex(
        (admin: { companyAdminEmail: string }) => admin.companyAdminEmail.toLowerCase() === companyAdminEmail.toLowerCase()
      ).toString(),
      performedByName: companyAdminExists.companyAdminName,
      targetCompany: companyExists._id.toString(),
      targetCompanyName: companyExists.companyName,
      details: {
        loginAt: new Date().toISOString(),
        ipAddress: req.ip
      },
      service: 'company-service',
    }, req);

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

router.post('/company-admin/refresh-token', async (req: Request, res: Response) => {
  try {
    const incomingRefreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME] || req.body?.refreshToken;
    if (!incomingRefreshToken) {
      return res.status(401).json({ message: 'Refresh token missing' });
    }

    const hashedToken = hashRefreshToken(incomingRefreshToken);
    const session = await CompanyAdminSession.findOne({ refreshTokenHash: hashedToken });

    if (!session) {
      clearAuthCookies(res);
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    if (session.expiresAt.getTime() < Date.now()) {
      await session.deleteOne();
      clearAuthCookies(res);
      return res.status(401).json({ message: 'Refresh token expired' });
    }

    const company = await Company.findById(session.companyId).lean();
    if (!company) {
      await session.deleteOne();
      clearAuthCookies(res);
      return res.status(401).json({ message: 'Company not found' });
    }

    if (!company.isVerified) {
      await session.deleteOne();
      clearAuthCookies(res);
      return res.status(401).json({ message: 'Company is not verified' });
    }

    const companyAdminExists = (company.companyAdminIDDetails || []).find(
      (admin: { companyAdminEmail: string }) => admin.companyAdminEmail.toLowerCase() === session.companyAdminEmail
    );

    if (!companyAdminExists) {
      await session.deleteOne();
      clearAuthCookies(res);
      return res.status(401).json({ message: 'Company admin not found' });
    }

    const token = jwt.sign(
      {
        companyAdminId: (company.companyAdminIDDetails || []).findIndex(
          (admin: { companyAdminEmail: string }) => admin.companyAdminEmail.toLowerCase() === session.companyAdminEmail
        ),
        companyAdminEmail: session.companyAdminEmail,
        companyAdminName: companyAdminExists.companyAdminName,
        companyId: company._id?.toString(),
        companyApiKey: company.companyApiKey,
        companyName: company.companyName
      } as JwtPayload,
      COMPANY_JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS }
    );

    const newRefreshToken = createRefreshToken();
    session.refreshTokenHash = hashRefreshToken(newRefreshToken);
    session.expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    session.lastUsedAt = new Date();
    session.userAgent = req.headers['user-agent'] || session.userAgent;
    session.ipAddress = req.ip || session.ipAddress;
    await session.save();

    setAuthCookies(res, token, newRefreshToken);
    console.log('[Session] Merchant admin refresh issued', {
      companyName: company.companyName,
      companyAdminName: companyAdminExists.companyAdminName,
      companyAdminEmail: companyAdminExists.companyAdminEmail.toLowerCase(),
    });

    return res.status(200).json({
      message: 'Tokens refreshed successfully',
      token,
      companyAdmin: {
        companyAdminName: companyAdminExists.companyAdminName,
        companyAdminEmail: companyAdminExists.companyAdminEmail
      }
    });
  } catch (error: any) {
    console.error('Error refreshing token:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        message: 'Internal server error',
        error: error?.message || 'An unknown error occurred'
      });
    }
  }
});

router.post('/company-admin/logout', async (req: Request, res: Response) => {
  try {
    const incomingRefreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME] || req.body?.refreshToken;
    if (incomingRefreshToken) {
      await CompanyAdminSession.deleteOne({ refreshTokenHash: hashRefreshToken(incomingRefreshToken) });
    }

    clearAuthCookies(res);

    return res.status(200).json({ message: 'Logout successful' });
  } catch (error: any) {
    console.error('Error logging out:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        message: 'Internal server error',
        error: error?.message || 'An unknown error occurred'
      });
    }
  }
});

/**
 * Change password for a company admin.
 * 
 * Validates the current password, checks new password strength, and updates
 * the admin's password in both the Company model's companyAdminIDDetails array
 * and the CompanyAdmin collection. The new password must be different from the
 * current password. Requires authentication via company admin JWT token.
 * 
 * @route POST /company-admin/change-password
 * @access Private (requires Company Admin JWT token)
 * 
 * @param {string} req.body.currentPassword - Current password for verification
 * @param {string} req.body.newPassword - New password (must meet strength requirements)
 * 
 * @returns {Object} 200 - Password changed successfully
 * @returns {Object} 400 - Validation error (missing fields, invalid format, same password)
 * @returns {Object} 401 - Invalid credentials (incorrect current password or unauthorized)
 */
router.post('/company-admin/change-password', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const companyAdminEmail = res.locals.companyAdminEmail;
    const companyId = res.locals.companyId;
    const companyAdminName = res.locals.companyAdminName;

    // Validation checks
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          currentPassword: !currentPassword ? 'Current password is required' : null,
          newPassword: !newPassword ? 'New password is required' : null
        }
      });
    }

    // Validate new password strength
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({
        message: 'Invalid password',
        error: 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)'
      });
    }

    // Check if new password is the same as the current password
    if (newPassword === currentPassword) {
      return res.status(400).json({
        message: 'Invalid password',
        error: 'The new password must be different from the current password'
      });
    }

    // Find company and verify admin exists
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system'
      });
    }

    // Find the admin in companyAdminIDDetails array
    const companyAdminExists = (company.companyAdminIDDetails || []).find(
      (admin: { companyAdminEmail: string }) => admin.companyAdminEmail.toLowerCase() === companyAdminEmail.toLowerCase()
    );

    if (!companyAdminExists) {
      return res.status(404).json({
        message: 'Company admin not found',
        error: 'Company admin not found with this email'
      });
    }

    // Verify current password
    const isPasswordValid = await verifyPassword(currentPassword, companyAdminExists.companyAdminPassword);
    if (!isPasswordValid) {
      return res.status(401).json({
        message: 'Invalid credentials',
        error: 'The current password you provided is incorrect'
      });
    }

    // Hash new password
    let hashedNewPassword: string;
    if (bcrypt && typeof bcrypt.hash === 'function') {
      hashedNewPassword = await bcrypt.hash(newPassword, 12);
    } else {
      const salt = randomBytes(16).toString('hex');
      const derived = scryptSync(newPassword, salt, 64).toString('hex');
      hashedNewPassword = `${salt}:${derived}`;
    }

    // Update password in Company model's companyAdminIDDetails array
    const adminIndex = (company.companyAdminIDDetails || []).findIndex(
      (admin: { companyAdminEmail: string }) => admin.companyAdminEmail.toLowerCase() === companyAdminEmail.toLowerCase()
    );

    if (adminIndex !== -1) {
      company.companyAdminIDDetails[adminIndex].companyAdminPassword = hashedNewPassword;
      await company.save();
    }

    // Update password in CompanyAdmin collection
    await CompanyAdmin.updateOne(
      { companyAdminEmail: companyAdminEmail.toLowerCase() },
      { companyAdminPassword: hashedNewPassword }
    );

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'company_admin_password_changed',
      ...userInfo,
      targetCompany: companyId,
      targetCompanyName: company.companyName,
      targetAdmin: companyAdminEmail.toLowerCase(),
      details: {
        adminEmail: companyAdminEmail.toLowerCase(),
        adminName: companyAdminName,
      },
      service: 'company-service',
    }, req);

    return res.status(200).json({
      message: 'Your password has been changed successfully. Please login with your new password.'
    });
  } catch (error: any) {
    console.error('Error changing password:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        message: 'Internal server error',
        error: error?.message || 'An unknown error occurred'
      });
    }
  }
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
 * Also attempts to include basic company information for convenience.
 * Useful for frontend token validation and session checks.
 * 
 * @route GET /company-admin/verify-token
 * @access Public (but requires valid JWT token)
 * 
 * @param {string} req.headers.authorization - Bearer token (JWT)
 * 
 * @returns {Object} 200 - Token verified with admin and optional company details
 * @returns {Object} 401 - Invalid or expired token
 */
router.get('/company-admin/verify-token', async (req: Request, res: Response) => {
  try {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized', error: 'No token provided' });
    }
    const decoded = jwt.verify(token, COMPANY_JWT_SECRET) as JwtPayload;

    let companyInfo: any = null;
    if (decoded.companyId) {
      const company = await Company.findById(decoded.companyId).select(
        'companyName companyEmail isVerified isActive isServiceActive apiKeyActive deliveryTimeHours'
      );
      if (company) {
        companyInfo = {
          companyId: company._id.toString(),
          companyName: company.companyName,
          companyEmail: company.companyEmail,
          isVerified: company.isVerified,
          isActive: company.isActive,
          isServiceActive: company.isServiceActive,
          apiKeyActive: company.apiKeyActive,
          deliveryTimeHours: company.deliveryTimeHours,
        };
      }
    }

    res.status(200).json({
      message: 'Token verified',
      companyAdmin: {
        companyAdminName: decoded.companyAdminName,
        companyAdminEmail: decoded.companyAdminEmail,
      },
      company: companyInfo,
      // For convenience / backwards compatibility
      companyId: companyInfo?.companyId || decoded.companyId,
      companyName: companyInfo?.companyName,
    });
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
  res.json({ valid: true, company: companyExist });
});

/**
 * Returns the current service status for a company.
 *
 * @route GET /service-status
 * @access Private (requires company API key via gateway validation)
 */
router.get('/service-status', async (req: Request, res: Response) => {
  try {
    const apiKey = (req.headers['your_company_api_key'] as string)?.trim();

    if (!apiKey) {
      return res.status(400).json({
        message: 'Company API key is required',
        error: 'Please include your_company_api_key header'
      });
    }

    const company = await Company.findOne({ companyApiKey: apiKey }).select(
      'companyName companyEmail isVerified isActive isServiceActive apiKeyActive deliveryTimeHours updatedAt'
    );

    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Invalid Company API key'
      });
    }

    res.status(200).json({
      message: 'Service status retrieved successfully',
      status: {
        companyId: company._id,
        companyName: company.companyName,
        companyEmail: company.companyEmail,
        isVerified: company.isVerified,
        isActive: company.isActive,
        isServiceActive: company.isServiceActive,
        apiKeyActive: company.apiKeyActive,
        deliveryTimeHours: company.deliveryTimeHours,
        lastUpdatedAt: company.updatedAt
      }
    });
  } catch (error: any) {
    console.error('Error fetching service status:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Update service status for the current company (merchant admin).
 *
 * Allows a merchant admin to toggle whether their company is currently
 * accepting orders and to update the default delivery time.
 *
 * @route PATCH /service-status
 * @access Private (requires Company Admin JWT token via gateway)
 *
 * @param {boolean} [req.body.isServiceActive] - Whether the company is currently accepting orders
 * @param {number}  [req.body.deliveryTimeHours] - Default fulfillment time in hours
 *
 * @returns {Object} 200 - Updated service status
 * @returns {Object} 400 - Validation error
 */
router.patch('/service-status', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const { isServiceActive, deliveryTimeHours } = req.body || {};

    if (typeof isServiceActive !== 'boolean' && typeof deliveryTimeHours !== 'number') {
      return res.status(400).json({
        message: 'Validation error',
        error: 'At least one of isServiceActive (boolean) or deliveryTimeHours (number) is required',
      });
    }

    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system',
      });
    }

    const previous = {
      isServiceActive: company.isServiceActive,
      deliveryTimeHours: company.deliveryTimeHours,
    };

    if (typeof isServiceActive === 'boolean') {
      company.isServiceActive = isServiceActive;
    }
    if (typeof deliveryTimeHours === 'number') {
      company.deliveryTimeHours = deliveryTimeHours;
    }

    await company.save();

    // Audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'company_service_status_updated',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      details: {
        previous,
        updated: {
          isServiceActive: company.isServiceActive,
          deliveryTimeHours: company.deliveryTimeHours,
        },
      },
      service: 'company-service',
    }, req);

    return res.status(200).json({
      message: 'Service status updated successfully',
      status: {
        companyId: company._id,
        companyName: company.companyName,
        companyEmail: company.companyEmail,
        isVerified: company.isVerified,
        isActive: company.isActive,
        isServiceActive: company.isServiceActive,
        apiKeyActive: company.apiKeyActive,
        deliveryTimeHours: company.deliveryTimeHours,
        lastUpdatedAt: company.updatedAt,
      },
    });
  } catch (error: any) {
    console.error('Error updating service status:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred',
    });
  }
});

/**
 * Get order auto-deletion settings for the current company (merchant admin).
 *
 * @route GET /deletion-settings
 * @access Private (requires Company Admin JWT token via gateway)
 *
 * @returns {Object} 200 - Current deletion settings
 */
router.get('/deletion-settings', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId).select('orderDeletionSettings');
    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system',
      });
    }

    const settings = company.orderDeletionSettings || {
      enabled: false,
      daysToDelete: 3,
      deletionTime: '21:00',
    };

    return res.status(200).json({
      message: 'Order deletion settings retrieved successfully',
      orderDeletionSettings: settings,
    });
  } catch (error: any) {
    console.error('Error fetching deletion settings:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred',
    });
  }
});

/**
 * Update order auto-deletion settings for the current company (merchant admin).
 *
 * @route PATCH /deletion-settings
 * @access Private (requires Company Admin JWT token via gateway)
 *
 * @param {boolean} req.body.enabled - Whether automatic deletion is enabled
 * @param {number}  req.body.daysToDelete - Number of days after which uncompleted orders are deleted
 * @param {string}  [req.body.deletionTime] - Time of day to run deletion (HH:mm, 24h)
 *
 * @returns {Object} 200 - Updated settings
 * @returns {Object} 400 - Validation error
 */
router.patch('/deletion-settings', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const { enabled, daysToDelete, deletionTime } = req.body || {};

    if (typeof enabled !== 'boolean' || typeof daysToDelete !== 'number') {
      return res.status(400).json({
        message: 'Validation error',
        error: 'enabled (boolean) and daysToDelete (number) are required',
      });
    }

    if (daysToDelete < 1) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'daysToDelete must be at least 1',
      });
    }

    if (deletionTime && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(deletionTime)) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'deletionTime must be in HH:mm 24-hour format',
      });
    }

    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system',
      });
    }

    const previous = company.orderDeletionSettings ?? {
      enabled: false,
      daysToDelete: 3,
      deletionTime: '21:00',
    };

    company.orderDeletionSettings = {
      enabled,
      daysToDelete,
      deletionTime: deletionTime || previous.deletionTime || '21:00',
    };

    await company.save();

    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'order_deletion_settings_updated',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      details: {
        previous,
        updated: company.orderDeletionSettings,
      },
      service: 'company-service',
    }, req);

    return res.status(200).json({
      message: 'Order deletion settings updated successfully',
      orderDeletionSettings: company.orderDeletionSettings,
    });
  } catch (error: any) {
    console.error('Error updating deletion settings:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred',
    });
  }
});

const buildDefaultServiceSchedule = () => ({
  enabled: false,
  schedule: {
    monday: { enabled: false, startTime: '09:00', endTime: '17:00' },
    tuesday: { enabled: false, startTime: '09:00', endTime: '17:00' },
    wednesday: { enabled: false, startTime: '09:00', endTime: '17:00' },
    thursday: { enabled: false, startTime: '09:00', endTime: '17:00' },
    friday: { enabled: false, startTime: '09:00', endTime: '17:00' },
    saturday: { enabled: false, startTime: '09:00', endTime: '17:00' },
    sunday: { enabled: false, startTime: '09:00', endTime: '17:00' },
  },
});

/**
 * Get service schedule for the current company (merchant admin).
 *
 * @route GET /service-schedule
 * @access Private (requires Company Admin JWT token via gateway)
 *
 * @returns {Object} 200 - Current service schedule
 */
router.get('/service-schedule', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId).select('serviceSchedule');
    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system',
      });
    }

    const schedule = company.serviceSchedule || buildDefaultServiceSchedule();

    return res.status(200).json({
      message: 'Service schedule retrieved successfully',
      serviceSchedule: schedule,
    });
  } catch (error: any) {
    console.error('Error fetching service schedule:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred',
    });
  }
});

/**
 * Update service schedule for the current company (merchant admin).
 *
 * @route PATCH /service-schedule
 * @access Private (requires Company Admin JWT token via gateway)
 *
 * @param {boolean} req.body.enabled - Whether schedule-based availability is enabled
 * @param {Object}  req.body.schedule - Per-day schedule configuration
 *
 * @returns {Object} 200 - Updated service schedule
 * @returns {Object} 400 - Validation error
 */
router.patch('/service-schedule', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const { enabled, schedule } = req.body || {};

    if (typeof enabled !== 'boolean' || typeof schedule !== 'object' || !schedule) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'enabled (boolean) and schedule (object) are required',
      });
    }

    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system',
      });
    }

    const previous = company.serviceSchedule || buildDefaultServiceSchedule();

    company.serviceSchedule = {
      enabled,
      schedule: {
        ...previous.schedule,
        ...schedule,
      },
    };

    await company.save();

    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'service_schedule_updated',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      details: {
        previous,
        updated: company.serviceSchedule,
      },
      service: 'company-service',
    }, req);

    return res.status(200).json({
      message: 'Service schedule updated successfully',
      serviceSchedule: company.serviceSchedule,
    });
  } catch (error: any) {
    console.error('Error updating service schedule:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred',
    });
  }
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

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'admin_email_added_to_company',
      ...userInfo,
      targetCompany: updatedCompany._id.toString(),
      targetCompanyName: updatedCompany.companyName,
      targetAdmin: newAdminEmail.toLowerCase(),
      details: {
        adminEmail: newAdminEmail.toLowerCase(),
        companyName: updatedCompany.companyName,
      },
      service: 'company-service',
    }, req);

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

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'company_verified',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      details: {
        oldValue: wasVerified,
        newValue: isVerified,
        onboardingTokenGenerated: tokenAssigned,
      },
      service: 'company-service',
    }, req);

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

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'company_api_key_status_changed',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      details: {
        oldValue: previous,
        newValue: active,
        status: active ? 'active' : 'inactive',
      },
      service: 'company-service',
    }, req);

    if (previous !== active) {
      await publishCompanyApiKeyStatusChanged({
        companyId: company._id.toString(),
        companyName: company.companyName,
        companyEmail: company.companyEmail,
        status: active ? 'active' : 'inactive',
        changerEmail: req.body.adminEmail || userInfo.performedBy
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
 * Bulk toggle API key status (active/inactive) for multiple companies.
 *
 * Allows CF Admins to enable/disable API keys for many companies in one request.
 * For each company:
 * - Updates `apiKeyActive`
 * - Writes an audit log entry
 * - Publishes `company_api_key_status_changed` event when status actually changes
 *
 * @route PATCH /company/api-key/status/bulk
 * @access Private (requires CF Admin JWT token)
 *
 * @param {Array<{ companyId: string; active: boolean }>} req.body.companies - List of companies and desired API key status
 *
 * @returns {Object} 200 - Summary of updates with per-company results
 * @returns {Object} 400 - Validation error (missing/invalid payload)
 */
router.patch('/company/api-key/status/bulk', verifyCFAdminToken, async (req: Request, res: Response) => {
  try {
    const { companies } = req.body || {};

    if (!Array.isArray(companies) || companies.length === 0) {
      return res.status(400).json({
        message: 'Invalid payload',
        error: 'companies must be a non-empty array of { companyId, active }',
      });
    }

    const userInfo = extractUserInfo(res.locals);
    const results: Array<{
      companyId: string;
      success: boolean;
      message: string;
    }> = [];

    for (const item of companies) {
      const { companyId, active } = item || {};

      if (!companyId || typeof active !== 'boolean') {
        results.push({
          companyId: companyId || 'unknown',
          success: false,
          message: 'companyId and boolean active are required',
        });
        continue;
      }

      try {
        const company = await Company.findById(companyId);
        if (!company) {
          results.push({
            companyId,
            success: false,
            message: 'Company not found',
          });
          continue;
        }

        const previous = company.apiKeyActive;
        company.apiKeyActive = active;
        await company.save();

        // Audit log
        await createAuditLog({
          action: 'company_api_key_status_changed',
          ...userInfo,
          targetCompany: company._id.toString(),
          targetCompanyName: company.companyName,
          details: {
            oldValue: previous,
            newValue: active,
            status: active ? 'active' : 'inactive',
            bulkOperation: true,
          },
          service: 'company-service',
        }, req);

        // Kafka event only if there was a real change
        if (previous !== active) {
          await publishCompanyApiKeyStatusChanged({
            companyId: company._id.toString(),
            companyName: company.companyName,
            companyEmail: company.companyEmail,
            status: active ? 'active' : 'inactive',
            changerEmail: req.body.adminEmail || userInfo.performedBy,
          });
        }

        results.push({
          companyId,
          success: true,
          message: `API key status updated to ${active ? 'active' : 'inactive'}`,
        });
      } catch (err: any) {
        console.error('Error updating API key status in bulk for company', companyId, err?.message || err);
        results.push({
          companyId,
          success: false,
          message: err?.message || 'Internal error while updating this company',
        });
      }
    }

    return res.status(200).json({
      message: 'Bulk API key status update completed',
      results,
    });
  } catch (error: any) {
    console.error('Error in bulk API key status update:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred',
    });
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

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'company_status_changed',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      details: {
        oldValue: previous,
        newValue: isActive,
        status: isActive ? 'active' : 'inactive',
        reason: reason || undefined,
      },
      service: 'company-service',
    }, req);

    if (previous !== isActive) {
      await publishCompanyStatusChanged({
        companyId: company._id.toString(),
        companyName: company.companyName,
        companyEmail: company.companyEmail,
        isActive,
        reason,
        changedBy: req.body.adminEmail || userInfo.performedBy
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

    // Also remove from CompanyAdmin collection
    await CompanyAdmin.deleteOne({
      companyAdminEmail: normalizedEmail
    });

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'company_admin_removed',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      targetAdmin: normalizedEmail,
      details: {
        removedAdminEmail: normalizedEmail,
        companyName: company.companyName,
      },
      service: 'company-service',
    }, req);

    await publishCompanyAdminRemoved({
      companyId: company._id.toString(),
      companyName: company.companyName,
      companyEmail: company.companyEmail,
      adminEmail: normalizedEmail,
      removedBy: {
        adminEmail: req.body.adminEmail || userInfo.performedBy,
        adminName: req.body.adminName || userInfo.performedByName
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

/**
 * Toggle service availability status for a company.
 * 
 * Allows company admins to activate or deactivate their service to stop receiving
 * orders. When deactivated, customers will receive a notification that the service
 * is currently unavailable when attempting to place orders. Useful for closing
 * hours, maintenance, or temporary unavailability.
 * 
 * @route PATCH /company/service-status
 * @access Private (requires Company Admin JWT token)
 * 
 * @param {boolean} req.body.isServiceActive - Whether to activate (true) or deactivate (false) the service
 * @param {string} [req.body.reason] - Optional reason for status change (for internal tracking)
 * 
 * @returns {Object} 200 - Service status updated successfully
 * @returns {Object} 400 - Validation error (isServiceActive must be boolean)
 * @returns {Object} 403 - Access denied (company not verified or inactive)
 */
router.patch('/company/service-status', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const { isServiceActive, reason } = req.body;

    if (typeof isServiceActive !== 'boolean') {
      return res.status(400).json({
        message: 'Validation error',
        error: 'isServiceActive field is required and must be a boolean'
      });
    }

    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId);

    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system'
      });
    }

    // Ensure company is verified and active
    if (!company.isVerified || !company.isActive) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Your company must be verified and active to manage service status'
      });
    }

    const previousStatus = company.isServiceActive;
    company.isServiceActive = isServiceActive;
    await company.save();

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'company_service_status_changed',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      details: {
        oldValue: previousStatus,
        newValue: isServiceActive,
        status: isServiceActive ? 'active' : 'inactive',
        reason: reason || undefined,
      },
      service: 'company-service',
    }, req);

    return res.status(200).json({
      message: `Service ${isServiceActive ? 'activated' : 'deactivated'} successfully`,
      company: {
        id: company._id,
        companyName: company.companyName,
        isServiceActive: company.isServiceActive,
        message: isServiceActive
          ? 'Your service is now active and accepting orders'
          : 'Your service is now inactive. Customers will be notified that you are not currently receiving orders.'
      }
    });
  } catch (error: any) {
    console.error('Error updating service status:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get service availability schedule for a company.
 * 
 * Returns the current service schedule configuration including weekly schedule
 * (Monday-Sunday) with start and end times for each day. Company admins can use
 * this to view their current schedule settings.
 * 
 * @route GET /company/service-schedule
 * @access Private (requires Company Admin JWT token)
 * 
 * @returns {Object} 200 - Service schedule retrieved successfully
 * @returns {Object} 403 - Access denied (company not verified or inactive)
 * @returns {Object} 404 - Company not found
 */
router.get('/company/service-schedule', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId);

    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system'
      });
    }

    // Ensure company is verified and active
    if (!company.isVerified || !company.isActive) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Your company must be verified and active to view service schedule'
      });
    }

    return res.status(200).json({
      message: 'Service schedule retrieved successfully',
      serviceSchedule: company.serviceSchedule || {
        enabled: false,
        schedule: {
          monday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          tuesday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          wednesday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          thursday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          friday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          saturday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          sunday: { enabled: false, startTime: '09:00', endTime: '17:00' }
        }
      }
    });
  } catch (error: any) {
    console.error('Error fetching service schedule:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Update service availability schedule for a company.
 * 
 * Allows company admins to configure a weekly schedule for service availability.
 * When schedule-based availability is enabled, the system will automatically check
 * if the current time falls within the configured hours for the current day before
 * accepting orders. This is useful for businesses with regular operating hours.
 * 
 * @route PATCH /company/service-schedule
 * @access Private (requires Company Admin JWT token)
 * 
 * @param {boolean} req.body.enabled - Whether schedule-based availability is enabled
 * @param {Object} req.body.schedule - Weekly schedule configuration
 * @param {Object} req.body.schedule.monday - Monday schedule { enabled, startTime, endTime }
 * @param {Object} req.body.schedule.tuesday - Tuesday schedule { enabled, startTime, endTime }
 * @param {Object} req.body.schedule.wednesday - Wednesday schedule { enabled, startTime, endTime }
 * @param {Object} req.body.schedule.thursday - Thursday schedule { enabled, startTime, endTime }
 * @param {Object} req.body.schedule.friday - Friday schedule { enabled, startTime, endTime }
 * @param {Object} req.body.schedule.saturday - Saturday schedule { enabled, startTime, endTime }
 * @param {Object} req.body.schedule.sunday - Sunday schedule { enabled, startTime, endTime }
 * 
 * @returns {Object} 200 - Service schedule updated successfully
 * @returns {Object} 400 - Validation error (invalid time format, missing fields)
 * @returns {Object} 403 - Access denied (company not verified or inactive)
 */
router.patch('/company/service-schedule', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const { enabled, schedule } = req.body;
    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId);

    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system'
      });
    }

    // Ensure company is verified and active
    if (!company.isVerified || !company.isActive) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Your company must be verified and active to manage service schedule'
      });
    }

    // Validate enabled field
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({
        message: 'Validation error',
        error: 'enabled field must be a boolean'
      });
    }

    // Validate schedule structure if provided
    if (schedule) {
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

      for (const day of days) {
        if (schedule[day]) {
          const daySchedule = schedule[day];

          // Validate enabled field
          if (daySchedule.enabled !== undefined && typeof daySchedule.enabled !== 'boolean') {
            return res.status(400).json({
              message: 'Validation error',
              error: `${day}.enabled must be a boolean`
            });
          }

          // Validate time format
          if (daySchedule.startTime && !timeRegex.test(daySchedule.startTime)) {
            return res.status(400).json({
              message: 'Validation error',
              error: `${day}.startTime must be in HH:mm format (24-hour)`
            });
          }

          if (daySchedule.endTime && !timeRegex.test(daySchedule.endTime)) {
            return res.status(400).json({
              message: 'Validation error',
              error: `${day}.endTime must be in HH:mm format (24-hour)`
            });
          }

          // Validate that endTime is after startTime
          if (daySchedule.startTime && daySchedule.endTime) {
            const [startHour, startMin] = daySchedule.startTime.split(':').map(Number);
            const [endHour, endMin] = daySchedule.endTime.split(':').map(Number);
            const startMinutes = startHour * 60 + startMin;
            const endMinutes = endHour * 60 + endMin;

            if (endMinutes <= startMinutes) {
              return res.status(400).json({
                message: 'Validation error',
                error: `${day}.endTime must be after ${day}.startTime`
              });
            }
          }
        }
      }
    }

    // Update service schedule
    const previousSchedule = company.serviceSchedule;

    if (!company.serviceSchedule) {
      company.serviceSchedule = {
        enabled: false,
        schedule: {
          monday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          tuesday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          wednesday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          thursday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          friday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          saturday: { enabled: false, startTime: '09:00', endTime: '17:00' },
          sunday: { enabled: false, startTime: '09:00', endTime: '17:00' }
        }
      };
    }

    // Update enabled flag if provided
    if (enabled !== undefined) {
      company.serviceSchedule.enabled = enabled;
    }

    // Update schedule if provided
    if (schedule) {
      const days: Array<'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'> = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      for (const day of days) {
        if (schedule[day]) {
          if (schedule[day].enabled !== undefined) {
            company.serviceSchedule.schedule[day].enabled = schedule[day].enabled;
          }
          if (schedule[day].startTime) {
            company.serviceSchedule.schedule[day].startTime = schedule[day].startTime;
          }
          if (schedule[day].endTime) {
            company.serviceSchedule.schedule[day].endTime = schedule[day].endTime;
          }
        }
      }
    }

    await company.save();

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'company_service_schedule_updated',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      details: {
        oldValue: previousSchedule,
        newValue: company.serviceSchedule,
        enabled: company.serviceSchedule.enabled,
      },
      service: 'company-service',
    }, req);

    return res.status(200).json({
      message: 'Service schedule updated successfully',
      serviceSchedule: company.serviceSchedule
    });
  } catch (error: any) {
    console.error('Error updating service schedule:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get order deletion settings for a company.
 * 
 * Returns the current order deletion settings including whether automatic deletion
 * is enabled, how many days to keep orders, and the time of day to run deletion.
 * Company admins can use this to view their current deletion configuration.
 * 
 * @route GET /company/deletion-settings
 * @access Private (requires Company Admin JWT token)
 * 
 * @returns {Object} 200 - Deletion settings retrieved successfully
 * @returns {Object} 403 - Access denied (company not verified or inactive)
 * @returns {Object} 404 - Company not found
 */
router.get('/company/deletion-settings', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId);

    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system'
      });
    }

    // Ensure company is verified and active
    if (!company.isVerified || !company.isActive) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Your company must be verified and active to view deletion settings'
      });
    }

    return res.status(200).json({
      message: 'Deletion settings retrieved successfully',
      deletionSettings: company.orderDeletionSettings || {
        enabled: false,
        daysToDelete: 3,
        deletionTime: '21:00'
      }
    });
  } catch (error: any) {
    console.error('Error fetching deletion settings:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Update order deletion settings for a company.
 * 
 * Allows company admins to configure automatic order deletion. When enabled,
 * uncompleted orders older than the specified number of days will be automatically
 * marked as deleted at the configured time each day. Only uncompleted orders
 * (not status "completed") are eligible for automatic deletion.
 * 
 * @route PATCH /company/deletion-settings
 * @access Private (requires Company Admin JWT token)
 * 
 * @param {boolean} [req.body.enabled] - Whether automatic deletion is enabled
 * @param {number} [req.body.daysToDelete] - Number of days to keep orders before deletion (minimum 1)
 * @param {string} [req.body.deletionTime] - Time of day to run deletion (format: "HH:mm" in 24-hour format, e.g., "21:00")
 * 
 * @returns {Object} 200 - Deletion settings updated successfully
 * @returns {Object} 400 - Validation error (invalid time format, daysToDelete < 1)
 * @returns {Object} 403 - Access denied (company not verified or inactive)
 */
router.patch('/company/deletion-settings', verifyCompanyAdminToken, async (req: Request, res: Response) => {
  try {
    const { enabled, daysToDelete, deletionTime } = req.body;
    const companyId = res.locals.companyId;
    const company = await Company.findById(companyId);

    if (!company) {
      return res.status(404).json({
        message: 'Company not found',
        error: 'Your company was not found in the system'
      });
    }

    // Ensure company is verified and active
    if (!company.isVerified || !company.isActive) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Your company must be verified and active to manage deletion settings'
      });
    }

    // Validate enabled field
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({
        message: 'Validation error',
        error: 'enabled field must be a boolean'
      });
    }

    // Validate daysToDelete
    if (daysToDelete !== undefined) {
      if (typeof daysToDelete !== 'number' || daysToDelete < 1 || !Number.isInteger(daysToDelete)) {
        return res.status(400).json({
          message: 'Validation error',
          error: 'daysToDelete must be an integer greater than or equal to 1'
        });
      }
    }

    // Validate deletionTime format
    if (deletionTime !== undefined) {
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(deletionTime)) {
        return res.status(400).json({
          message: 'Validation error',
          error: 'deletionTime must be in HH:mm format (24-hour), e.g., "21:00"'
        });
      }
    }

    // Initialize orderDeletionSettings if it doesn't exist
    if (!company.orderDeletionSettings) {
      company.orderDeletionSettings = {
        enabled: false,
        daysToDelete: 3,
        deletionTime: '21:00'
      };
    }

    const previousSettings = { ...company.orderDeletionSettings };

    // Update fields if provided
    if (enabled !== undefined) {
      company.orderDeletionSettings.enabled = enabled;
    }
    if (daysToDelete !== undefined) {
      company.orderDeletionSettings.daysToDelete = daysToDelete;
    }
    if (deletionTime !== undefined) {
      company.orderDeletionSettings.deletionTime = deletionTime;
    }

    await company.save();

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'company_deletion_settings_updated',
      ...userInfo,
      targetCompany: company._id.toString(),
      targetCompanyName: company.companyName,
      details: {
        oldValue: previousSettings,
        newValue: company.orderDeletionSettings,
      },
      service: 'company-service',
    }, req);

    return res.status(200).json({
      message: 'Deletion settings updated successfully',
      deletionSettings: company.orderDeletionSettings
    });
  } catch (error: any) {
    console.error('Error updating deletion settings:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
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
//   "companyApiKey": "FFM_1234567890"
// }
