import { Request, Response, NextFunction } from 'express';

// Middleware to preserve original request body before verifyCFAdminToken overwrites it
// This is useful when the request body contains fields that might be overwritten by middleware
export const preserveRequestBody = (req: Request, res: Response, next: NextFunction) => {
  // Save original body before middleware modifies it
  if (req.body && req.body.adminEmail) {
    res.locals.originalAdminEmail = req.body.adminEmail;
  }
  next();
};

