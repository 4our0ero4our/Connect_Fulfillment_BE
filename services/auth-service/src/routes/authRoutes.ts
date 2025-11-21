// The routes in here are for the auth service to register (/register), login (/login), logout (/logout), change password (/change-password)
import { Router } from 'express';
import { Request, Response } from 'express';
import { Admin } from '../models/Admin';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import jwt, { JwtPayload } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from '../middleware/rateLimit';
import { verifyCFAdminToken } from '../middleware/verifyCFAdminToken';
import { verifyLeadCFAdmin } from '../middleware/verifyLeadCFAdmin';
import { preserveRequestBody } from '../middleware/preserveRequestBody';
import { Staff } from '../models/Staff';

const router = Router();
// Try multiple paths for .env file (works in both local and Docker)
dotenv.config({ path: '.env' });
dotenv.config({ path: './.env' });
dotenv.config(); // Also try default .env in root

// Validates company email by checking if the email is in the staffs collection in the database.
const isValidCFStaffEmail = async (email: string): Promise<boolean> => {
  const staffsCollection = mongoose.connection.collection('staffs');
  const staff = await staffsCollection.findOne({ email: email });
  return staff ? true : false;
};

// Validates if the staff can be a Connect Fulfillment admin
const isValidCFAdminStaff = async (email: string): Promise<boolean> => {
  const staffsCollection = mongoose.connection.collection('staffs');
  const staff = await staffsCollection.findOne({ email: email, canBeCFAdmin: true });
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

// Validates if the staff is a lead Connect Fulfillment admin (helper function for route logic)
const isValidLeadCFAdmin = async (email: string): Promise<boolean> => {
  const staffsCollection = mongoose.connection.collection('staffs');
  const staff = await staffsCollection.findOne({ email: email, isALeadCFAdmin: true });
  return staff ? true : false;
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
      console.log('Validation failed: Missing required fields');
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
      console.log('Invalid email format:', adminEmail);
      return res.status(400).json({
        message: 'Invalid email format',
        error: 'Please enter a valid email address'
      });
    }

    // Validate company email
    if (!(await isValidCFStaffEmail(adminEmail))) {
      console.log('Invalid Connect Fulfillment staff email:', adminEmail);
      return res.status(400).json({
        message: 'Invalid Connect Fulfillment staff email',
        error: 'Only Connect Fulfillment staff emails are allowed to register'
      });
    }
    // Validate if the staff can be a Connect Fulfillment admin
    if (!(await isValidCFAdminStaff(adminEmail))) {
      console.log('Connect Fulfillment staff cannot be a Connect Fulfillment admin:', adminEmail);
      return res.status(400).json({
        message: 'Connect Fulfillment staff cannot be a Connect Fulfillment admin',
        error: 'Only Connect Fulfillment staff that can be a Connect Fulfillment admin can register'
      });
    }

    // Validate password strength
    if (!isValidPassword(password)) {
      console.log('Password does not meet requirements');
      return res.status(400).json({
        message: 'Password does not meet requirements',
        error: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)'
      });
    }

    // Check if admin already exists
    console.log('🔍 Checking if admin already exists...');
    const existingAdmin = await Admin.findOne({ adminEmail: adminEmail.toLowerCase() });
    if (existingAdmin) {
      console.log('Admin already exists:', adminEmail);
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
    console.error('Registration error:', {
      error: error.message,
      stack: error.stack,
      processingTime: `${processingTime}ms`,
      adminEmail: req.body?.adminEmail
    });

    // Handles MongoDB duplicate key error
    if (error.code === 11000) {
      console.log('Duplicate key error - admin already exists');
      return res.status(409).json({
        message: 'Admin already exists',
        error: 'An admin with this email is already registered'
      });
    }

    // Handles MongoDB connection errors
    if (error.name === 'MongoNetworkError' || error.name === 'MongoTimeoutError') {
      console.log('MongoDB connection error');
      return res.status(503).json({
        message: 'Database temporarily unavailable',
        error: 'Please try again in a moment'
      });
    }

    // Handles validation errors
    if (error.name === 'ValidationError') {
      console.log('Validation error:', error.message);
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
    if (!(await isValidCFStaffEmail(adminEmail))) {
      return res.status(400).json({
        message: 'Invalid Connect Fulfillment staff email',
        error: 'Only Connect Fulfillment staff emails are allowed to login'
      });
    }
    // Validate if the staff can be a Connect Fulfillment admin
    if (!(await isValidCFAdminStaff(adminEmail))) {
      console.log('Connect Fulfillment staff cannot be a Connect Fulfillment admin:', adminEmail);
      return res.status(400).json({
        message: 'Connect Fulfillment staff cannot be a Connect Fulfillment admin',
        error: 'Only Connect Fulfillment staff that can be a Connect Fulfillment admin can login'
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
// export const verifyToken = (req: Request, res: Response, next: any) => {
//   try {
//     const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

//     if (!token) {
//       return res.status(401).json({
//         message: 'Access denied',
//         error: 'No token provided'
//       });
//     }

//     const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
//     req.body.adminId = decoded.adminId;
//     req.body.adminEmail = decoded.adminEmail;
//     req.body.adminName = decoded.adminName;
//     next();
//   } catch (error) {
//     return res.status(401).json({
//       message: 'Invalid token',
//       error: 'Token verification failed'
//     });
//   }
// };

// ✅ Working perfectly
// Logout endpoint (clients should delete their JWT on logout)
router.get('/logout', verifyCFAdminToken, (_req: Request, res: Response) => {
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
// Protected route example to conform that verifyCFAdminToken Middleware works
router.get('/profile', verifyCFAdminToken, (req: Request, res: Response) => {
  res.json({
    message: 'Admin profile',
    admin: {
      id: req.body.adminId,
      adminName: req.body.adminName,
      adminEmail: req.body.adminEmail,
      // Added these in case we need to display those details in the frontend
      role: req.body.role,
      canBeCFAdmin: req.body.canBeCFAdmin,
      isALeadCFAdmin: req.body.isALeadCFAdmin,
      createdAt: req.body.createdAt,
      updatedAt: req.body.updatedAt
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

    // Check if new password is the same as the current password
    if (newPassword === currentPassword) {
      return res.status(400).json({ message: 'Invalid password', error: 'The new password you provided is the same as the current password' });
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

// ✅ Working Perfectly
// Add a new staff endpoint (to add a new staff)
router.post('/add-staff', rateLimit(5, 60, 'add-staff'), verifyCFAdminToken, verifyLeadCFAdmin, async (req: Request, res: Response) => {
  try {
    const { newStaffEmail, newStaffName, newStaffRole, canBeCFAdmin, isALeadCFAdmin } = req.body;

    // Validation checks
    if (!newStaffEmail || !newStaffName || !newStaffRole) {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          newStaffEmail: !newStaffEmail ? 'Staff email is required' : null,
          newStaffName: !newStaffName ? 'Staff name is required' : null,
          newStaffRole: !newStaffRole ? 'Staff role is required' : null,
        }
      });
    }

    // Validates email format
    if (!isValidEmailFormat(newStaffEmail)) {
      return res.status(400).json({
        message: 'Invalid email format',
        error: 'Please enter a valid email address'
      });
    }

    // Validates if the staff email is already in the database
    if (await isValidCFStaffEmail(newStaffEmail)) {
      return res.status(409).json({
        message: 'Staff email already exists',
        error: 'The staff email you provided is already in the database'
      });
    }

    // Validates staff role (Staff roles are gonna be included later in the database for confirmation purposes because it's gonna be a dropdown in the frontend)
    // if (newStaffRole !== 'admin' && newStaffRole !== 'staff') {
    //   return res.status(400).json({
    //     message: 'Invalid staff role',
    //     error: 'Staff role must be either "admin" or "staff"'
    //   });
    // }



    // Create staff
    const staff = await Staff.create({
      name: newStaffName,
      email: newStaffEmail.toLowerCase(),
      role: newStaffRole,
      canBeCFAdmin: canBeCFAdmin,
      isALeadCFAdmin: isALeadCFAdmin
    });

    // Return staff without sensitive data
    const staffResponse = staff.toObject();
    res.status(201).json({
      message: 'Staff added successfully',
      staff: {
        id: staffResponse._id,
        name: staffResponse.name,
        email: staffResponse.email,
        role: staffResponse.role,
        canBeCFAdmin: staffResponse.canBeCFAdmin,
        isALeadCFAdmin: staffResponse.isALeadCFAdmin,
        createdAt: staffResponse.createdAt,
        updatedAt: staffResponse.updatedAt
      }
    });

  } catch (error: any) {
    console.error('Error adding a staff:', error);

    // Handles MongoDB duplicate key error
    if (error.code === 11000) {
      return res.status(409).json({
        message: 'Staff email already exists',
        error: 'An staff with this email is already registered'
      });
    }

    // Handles validation errors
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Validation error',
        error: error.message
      });
    }

    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

// ✅ Working Perfectly
// Update a staff admin status endpoint (to update a staff admin status)
router.post('/update-staff-admin-status', rateLimit(5, 60, 'update-staff-admin-status'), verifyCFAdminToken, verifyLeadCFAdmin, async (req: Request, res: Response) => {
  try {
    const { staffEmail, canBeCFAdmin } = req.body;
    // Validation checks
    if (!staffEmail || typeof canBeCFAdmin !== 'boolean') {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          staffEmail: !staffEmail ? 'Staff email is required' : null,
          canBeCFAdmin: typeof canBeCFAdmin !== 'boolean' ? 'Can be a Connect Fulfillment admin status is required' : null
        }
      });
    }
    // Validates email format
    if (!isValidEmailFormat(staffEmail)) {
      return res.status(400).json({
        message: 'Invalid email format',
        error: 'Please enter a valid email address'
      });
    }
    // Validates if the staff email is in the database
    if (!(await isValidCFStaffEmail(staffEmail))) {
      return res.status(400).json({
        message: 'Staff email not found',
        error: 'The staff email you provided was not found in the database'
      });
    }
    // Updates the staff admin status
    await Staff.updateOne({ email: staffEmail }, { $set: { canBeCFAdmin: canBeCFAdmin } });
    const updatedStaff = await Staff.findOne({ email: staffEmail });
    if (!updatedStaff) {
      return res.status(400).json({
        message: 'Staff not found',
        error: 'The recently updated staff was not found in the database'
      });
    }
    const staffResponse = updatedStaff.toObject();
    return res.status(200).json({
      message: 'Staff admin status updated successfully', staff: {
        id: staffResponse._id,
        name: staffResponse.name,
        email: staffResponse.email,
        role: staffResponse.role,
        canBeCFAdmin: staffResponse.canBeCFAdmin,
        isALeadCFAdmin: staffResponse.isALeadCFAdmin,
      }
    });
  } catch (error: any) {
    console.error('Error updating a staff admin status:', error);
    return res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

// ✅ Working Perfectly
// Delete a staff endpoint (to delete a staff)
router.delete('/delete-staff', rateLimit(5, 60, 'delete-staff'), verifyCFAdminToken, verifyLeadCFAdmin, async (req: Request, res: Response) => {
  try {
    const { staffEmail } = req.body;

    // Validation checks
    if (!staffEmail) {
      return res.status(400).json({
        message: 'Staff email is required',
        error: 'Please enter a valid staff email'
      });
    }

    // Validates email format
    if (!isValidEmailFormat(staffEmail)) {
      return res.status(400).json({
        message: 'Invalid email format',
        error: 'Please enter a valid email address'
      });
    }

    // Validates if the staff email is in the database
    if (!(await isValidCFStaffEmail(staffEmail))) {
      return res.status(404).json({
        message: 'Staff email not found',
        error: 'The staff email you provided is not in the database'
      });
    }

    // Prevent deletion of lead admins 🌚
    const isStaffLeadAdmin = await isValidLeadCFAdmin(staffEmail);
    if (isStaffLeadAdmin) {
      return res.status(403).json({
        message: 'Cannot delete lead admin',
        error: 'Lead Connect Fulfillment admins cannot be deleted through this endpoint. Why do you want to delete a lead admin? 🤔 Only the dev can do that abeg. 🤣'
      });
    }

    // Deletes the staff from the database
    const deleteResult = await Staff.deleteOne({ email: staffEmail.toLowerCase() });
    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({
        message: 'Staff not found',
        error: 'The staff could not be deleted or was not found'
      });
    }

    return res.status(200).json({
      message: `Unfortunately and officially, ${staffEmail} is no more a Connect Fulfillment staff. Baba don pass him boundary bah? 🤣. It wasn't nice while it lasted, anyway! 💀`
    });
  } catch (error: any) {
    console.error('Error deleting a staff:', error);
    return res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

// Get all staffs endpoint (to get all staffs)
router.get('/get-all-staffs', rateLimit(5, 60, 'get-all-staffs'), verifyCFAdminToken, verifyLeadCFAdmin, async (_req: Request, res: Response): Promise<Response> => {
  try {
    const staffs = await Staff.find();
    if (!staffs) {
      return res.status(404).json({
        message: 'No staffs found',
        error: 'No staffs were found in the database'
      });
    }
    const staffResponse = staffs.map((staff) => staff.toObject());
    return res.status(200).json({
      message: 'All staffs fetched successfully', staffs: staffResponse.map((staff) => ({
        id: staff._id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        canBeCFAdmin: staff.canBeCFAdmin,
        isALeadCFAdmin: staff.isALeadCFAdmin,
      }))
    });
  } catch (error: any) {
    console.error('Error fetching all staffs:', error);
    return res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
});

// ✅ Working Perfectly
// Remove admin endpoint (to remove an admin)
router.delete('/remove-admin', rateLimit(5, 60, 'remove-admin'), preserveRequestBody, verifyCFAdminToken, verifyLeadCFAdmin, async (req: Request, res: Response) => {
  try {
    // Get the adminEmail from the original request body (saved before middleware overwrote it)
    const adminEmail = res.locals.originalAdminEmail || req.body.targetAdminEmail;
    
    // Validation checks
    if (!adminEmail) {
      return res.status(400).json({
        message: 'Admin email is required',
        error: 'Please enter a valid admin email in the request body'
      });
    }
    
    // Validates email format
    if (!isValidEmailFormat(adminEmail)) {
      return res.status(400).json({
        message: 'Invalid email format',
        error: 'Please enter a valid email address'
      });
    }
    
    const normalizedEmail = adminEmail.toLowerCase();
    
    // Check if the admin actually exists in the Admin collection
    const admin = await Admin.findOne({ adminEmail: normalizedEmail });
    if (!admin) {
      return res.status(404).json({
        message: 'Admin not found',
        error: 'The admin email you provided does not exist in the Admin collection'
      });
    }
    
    // Prevent removing yourself (optional business rule)
    const requesterEmail = res.locals.adminEmail || req.body.adminEmail; // From token
    if (normalizedEmail === requesterEmail?.toLowerCase()) {
      return res.status(403).json({
        message: 'Cannot remove yourself',
        error: 'You cannot remove your own admin account'
      });
    }
    
    // Remove the admin from the Admin collection
    const deleteResult = await Admin.deleteOne({ adminEmail: normalizedEmail });
    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({
        message: 'Admin not found',
        error: 'The admin could not be removed or was not found'
      });
    }
    
    // Update the Staff collection to set canBeCFAdmin to false
    const staffsCollection = mongoose.connection.collection('staffs');
    const updateResult = await staffsCollection.updateOne(
      { email: normalizedEmail },
      { $set: { canBeCFAdmin: false } }
    );
    
    console.log(`Admin ${normalizedEmail} removed. Staff collection updated:`, updateResult.modifiedCount > 0 ? 'Yes' : 'No');
    
    return res.status(200).json({
      message: `Unfortunately and officially, ${adminEmail} is no more a Connect Fulfillment admin. Baba don pass him boundary bah? 🤣. It wasn't fun while it lasted, anyway! 💀`,
      adminRemoved: true,
      staffUpdated: updateResult.modifiedCount > 0
    });
  } catch (error: any) {
    console.error('Error removing an admin:', error);
    return res.status(500).json({ 
      message: 'Internal server error', 
      error: error?.message || 'An unknown error occurred' 
    });
  }
});
export default router;




// All admins can access the Connect Fulfillment Dashboards but only the lead admins doesn't have limit as to what adn what not to do on the dashboard.