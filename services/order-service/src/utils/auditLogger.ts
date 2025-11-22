import { Request } from 'express';
import { AuditLog, IAuditLog } from '../models/AuditLog';

/**
 * Interface for audit log entry data.
 */
export interface AuditLogData {
  action: string;
  performedBy: string;
  performedByRole: 'cf_admin' | 'merchant_admin' | 'system';
  performedById?: string;
  performedByName?: string;
  targetCompany?: string;
  targetCompanyName?: string;
  targetOrder?: string;
  targetOrderNumber?: string;
  targetTicket?: string;
  targetAdmin?: string;
  targetStaff?: string;
  details: {
    oldValue?: any;
    newValue?: any;
    reason?: string;
    [key: string]: any;
  };
  service: string;
}

/**
 * Creates an audit log entry with exact timestamp.
 * 
 * This function creates an immutable audit trail of all actions in the system.
 * Logs include exact date and time, cannot be modified or deleted by anyone.
 * 
 * @param {AuditLogData} logData - The audit log data
 * @param {Request} [req] - Optional Express request object to extract IP and user agent
 * @returns {Promise<IAuditLog>} The created audit log entry
 */
export const createAuditLog = async (
  logData: AuditLogData,
  req?: Request
): Promise<IAuditLog> => {
  try {
    // Get exact current timestamp
    const exactTimestamp = new Date();
    
    // Extract IP address and user agent from request if provided
    const ipAddress = req?.ip || 
                     req?.headers['x-forwarded-for']?.toString().split(',')[0] || 
                     req?.socket.remoteAddress || 
                     undefined;
    const userAgent = req?.headers['user-agent'] || undefined;

    const auditLog = new AuditLog({
      ...logData,
      timestamp: exactTimestamp, // Exact date and time
      ipAddress,
      userAgent,
    });

    const savedLog = await auditLog.save();
    console.log(`✅ Audit log created: ${logData.action} by ${logData.performedBy} at ${exactTimestamp.toISOString()}`);
    return savedLog;
  } catch (error: any) {
    // Log errors but don't throw - audit logging should never break the main flow
    console.error('❌ Failed to create audit log:', error?.message || error);
    // Return a minimal log object to prevent breaking the calling code
    return {} as IAuditLog;
  }
};

/**
 * Helper function to extract user information from res.locals (set by middleware).
 * 
 * @param {any} locals - res.locals object from Express
 * @returns {Object} User information for audit logging
 */
export const extractUserInfo = (locals: any) => {
  // Check for CF Admin info
  if (locals.isAdmin && locals.adminEmail) {
    return {
      performedBy: locals.adminEmail,
      performedByRole: 'cf_admin' as const,
      performedById: locals.adminId,
      performedByName: locals.adminName,
    };
  }
  
  // Check for Company Admin info
  if (locals.isCompanyAdmin && locals.companyAdminEmail) {
    return {
      performedBy: locals.companyAdminEmail,
      performedByRole: 'merchant_admin' as const,
      performedById: locals.companyAdminId,
      performedByName: locals.companyAdminName,
    };
  }
  
  // Check for merchant (API key) info
  if (locals.isMerchant && locals.companyName) {
    return {
      performedBy: locals.companyName, // Use company name for API key requests
      performedByRole: 'merchant_admin' as const,
      performedById: locals.companyId,
      performedByName: locals.companyName,
    };
  }
  
  // Fallback to system
  return {
    performedBy: 'system@fulfillmate.com',
    performedByRole: 'system' as const,
  };
};

