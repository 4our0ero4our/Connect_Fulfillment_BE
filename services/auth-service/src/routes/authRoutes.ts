import { Router } from 'express';
import { Request, Response } from 'express';
import { Admin } from '../models/Admin';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import jwt, { JwtPayload } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from '../middleware/rateLimit';

const router = Router();
// Try multiple paths for .env file (works in both local and Docker)
dotenv.config({ path: '.env' });
dotenv.config({ path: './.env' });
dotenv.config(); // Also try default .env in root
  
// Validates company email by checking if the email is in the staffs collection in the database.
const isValidCompanyEmail = async (email: string): Promise<boolean> => {
  const staffsCollection = mongoose.connection.collection('staffs');
  const staff = await staffsCollection.findOne({ email: email });
  return staff ? true : false;
};

// Validates email format
const isValidEmailFormat = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Validates password strength
const isValidPassword = (password: string): boolean => {
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  return passwordRegex.test(password);
};

// ✅ Working perfectly
// Root endpoint (to confirm that Auth service is running)
router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Auth Service is running', service: 'auth-service' });
});

// ✅ Working perfectly
// Register endpoint (to register a new admin)
router.post('/register', rateLimit(5, 60, 'register'), async (req: Request, res: Response) => {
  const startTime = Date.now();
  console.log('🔄 Registration request received:', { 
    adminEmail: req.body?.adminEmail, 
    adminName: req.body?.adminName,
    timestamp: new Date().toISOString()
  });

  try {
    const { adminName, adminEmail, password } = req.body;

    // Validation checks
    if (!adminName || !adminEmail || !password) {
      console.log('❌ Validation failed: Missing required fields');
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          adminName: !adminName ? 'Admin name is required' : null,
          adminEmail: !adminEmail ? 'Admin email is required' : null,
          password: !password ? 'Password is required' : null
        }
      });
    }

    // Validate email format
    if (!isValidEmailFormat(adminEmail)) {
      console.log('❌ Invalid email format:', adminEmail);
      return res.status(400).json({
        message: 'Invalid email format',
        error: 'Please enter a valid email address'
      });
    }

    // Validate company email
    if (!(await isValidCompanyEmail(adminEmail))) {
      console.log('❌ Invalid company email:', adminEmail);
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only Connect Fulfillment staff emails are allowed to register'
      });
    }

    // Validate password strength
    if (!isValidPassword(password)) {
      console.log('❌ Password does not meet requirements');
      return res.status(400).json({
        message: 'Password does not meet requirements',
        error: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)'
      });
    }

    // Check if admin already exists
    console.log('🔍 Checking if admin already exists...');
    const existingAdmin = await Admin.findOne({ adminEmail: adminEmail.toLowerCase() });
    if (existingAdmin) {
      console.log('❌ Admin already exists:', adminEmail);
      return res.status(409).json({
        message: 'Admin already exists',
        error: 'An admin with this email is already registered'
      });
    }

    // Hash the password
    console.log('🔐 Hashing password...');
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create admin
    console.log('📝 Creating admin in database...');
    const admin = await Admin.create({
      adminName,
      adminEmail: adminEmail.toLowerCase(),
      password: hashedPassword
    });

    // Generate JWT token
    console.log('🎫 Generating JWT token...');
    const token = jwt.sign(
      {
        adminId: admin._id,
        adminEmail: admin.adminEmail,
        adminName: admin.adminName
      } as JwtPayload,
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );

    const processingTime = Date.now() - startTime;
    console.log('✅ Registration successful:', { 
      adminEmail: admin.adminEmail, 
      processingTime: `${processingTime}ms` 
    });

    res.status(201).json({
      message: 'Admin registered successfully',
      admin: {
        id: admin._id,
        adminName: admin.adminName,
        adminEmail: admin.adminEmail
      },
      token: token
    });

  } catch (error: any) {
    const processingTime = Date.now() - startTime;
    console.error('❌ Registration error:', {
      error: error.message,
      stack: error.stack,
      processingTime: `${processingTime}ms`,
      adminEmail: req.body?.adminEmail
    });

    // Handles MongoDB duplicate key error
    if (error.code === 11000) {
      console.log('❌ Duplicate key error - admin already exists');
      return res.status(409).json({
        message: 'Admin already exists',
        error: 'An admin with this email is already registered'
      });
    }

    // Handles MongoDB connection errors
    if (error.name === 'MongoNetworkError' || error.name === 'MongoTimeoutError') {
      console.log('❌ MongoDB connection error');
      return res.status(503).json({
        message: 'Database temporarily unavailable',
        error: 'Please try again in a moment'
      });
    }

    // Handles validation errors
    if (error.name === 'ValidationError') {
      console.log('❌ Validation error:', error.message);
      return res.status(400).json({
        message: 'Validation error',
        error: error.message
      });
    }

    res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

// ✅ Working perfectly
// Login endpoint (to login an admin)
router.post('/login', rateLimit(5, 60, 'login'), async (req: Request, res: Response) => {
  try {
    const { adminEmail, password } = req.body;

    // Validation checks
    if (!adminEmail || !password) {
      return res.status(400).json({
        message: 'Email and password are required',
        errors: {
          adminEmail: !adminEmail ? 'Admin email is required' : null,
          password: !password ? 'Password is required' : null
        }
      });
    }

    // Validates email format
    if (!isValidEmailFormat(adminEmail)) {
      return res.status(400).json({
        message: 'Invalid email format',
        error: 'Please enter a valid email address'
      });
    }

    // Validates company email
    if (!(await isValidCompanyEmail(adminEmail))) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only Connect Fulfillment staff emails are allowed to login'
      });
    }

    // Finds admin by email
    const admin = await Admin.findOne({ adminEmail: adminEmail.toLowerCase() });
    if (!admin) {
      return res.status(401).json({
        message: 'Invalid credentials',
        error: 'Admin not found with this email'
      });
    }

    // Verifies password
    const isPasswordValid = await bcrypt.compare(password, admin.password || '');
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid credentials', error: 'Incorrect password' });
    }

    // Generates JWT token
    const token = jwt.sign(
      {
        adminId: admin._id,
        adminEmail: admin.adminEmail,
        adminName: admin.adminName
      } as JwtPayload,
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );

    res.status(200).json({
      message: 'Login successful',
      admin: {
        id: admin._id,
        adminName: admin.adminName,
        adminEmail: admin.adminEmail
      },
      token: token
    });

  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
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
// Logout endpoint (clients should delete their JWT on logout)
router.get('/logout', verifyToken, (_req: Request, res: Response) => {
  // Removes the JWT from the client's browser
  res.clearCookie('token');
  res.clearCookie('connect.sid');
  res.clearCookie('session');
  res.clearCookie('sessionid');
  res.clearCookie('auth');
  res.clearCookie('auth-token');
  return res.status(200).json({ message: 'Logout successful' });
});


// ✅ Working perfectly
// Protected route example to conform that verifyToken Middleware works
router.get('/profile', verifyToken, (req: Request, res: Response) => {
  res.json({
    message: 'Admin profile',
    admin: {
      id: req.body.adminId,
      adminName: req.body.adminName,
      adminEmail: req.body.adminEmail
    }
  });
});

// ✅ Working perfectly
// Change password endpoint (to change an admin's password)
router.post('/change-password', rateLimit(5, 60, 'change-password'), async (req: Request, res: Response): Promise<Response> => {
  try {
    const { adminEmail, currentPassword, newPassword } = req.body;

    // Validation checks
    if (!adminEmail || !currentPassword || !newPassword) {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          adminEmail: !adminEmail ? 'Admin email is required' : null,
          currentPassword: !currentPassword ? 'Current password is required' : null,
          newPassword: !newPassword ? 'New password is required' : null
        }
      });
    }

    // Validates email format
    if (!isValidEmailFormat(adminEmail)) {
      return res.status(400).json({
        message: 'Invalid email format',
        error: 'Please enter a valid email address'
      });
    }

  // Finds admin by email
  const admin = await Admin.findOne({ adminEmail: adminEmail.toLowerCase() });
  if (!admin) {
    return res.status(401).json({ message: 'Invalid credentials', error: 'No admin with this email was found' });
  }
  const isPasswordValid = await bcrypt.compare(currentPassword, admin.password || '');
  // Verifies current password
  if (!isPasswordValid) {
    return res.status(401).json({ message: 'Invalid credentials', error: 'The current password you provided is incorrect' });
  }
  // Validates new password strength
  const newPasswordStrength = isValidPassword(newPassword);
  if (!newPasswordStrength) {
    return res.status(400).json({ message: 'Invalid password', error: 'The new password you provided does not meet the requirements' });
  }
  // Hashes new password
  const hashedNewPassword = await bcrypt.hash(newPassword, 12);
  admin.password = hashedNewPassword;
  await admin.save();
  return res.status(200).json({ message: 'Your password has been changed successfully. Please login with your new password.' });
} catch (error: any) {
    return res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});
export default router;
