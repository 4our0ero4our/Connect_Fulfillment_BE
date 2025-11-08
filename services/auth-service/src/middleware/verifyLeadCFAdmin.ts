import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import mongoose from 'mongoose';

// Validates if the staff is a lead Connect Fulfillment admin
const isValidLeadCFAdmin = async (email: string): Promise<boolean> => {
  const staffsCollection = mongoose.connection.collection('staffs');
  const staff = await staffsCollection.findOne({ email: email, isALeadCFAdmin: true });
  return staff ? true : false;
};

// Middleware to verify that the admin is a lead Connect Fulfillment admin
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
    const isLeadAdmin = await isValidLeadCFAdmin(decoded.adminEmail);
    if (!isLeadAdmin) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'Only lead Connect Fulfillment admins can perform this action'
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      message: 'Internal server error',
      error: 'Failed to verify lead admin status'
    });
  }
};

