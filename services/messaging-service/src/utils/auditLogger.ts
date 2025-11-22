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
  targetTicket?: string;
  targetTicketNumber?: string;
  targetCompany?: string;
  targetCompanyName?: string;
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
 * @param {AuditLogData} logData - The audit log data
 * @param {Request} [req] - Optional Express request object to extract IP and user agent
 * @returns {Promise<IAuditLog>} The created audit log entry
 */
export const createAuditLog = async (
  logData: AuditLogData,
  req?: Request
): Promise<IAuditLog> => {
  try {
    const exactTimestamp = new Date();
    const ipAddress = req?.ip || 
                     req?.headers['x-forwarded-for']?.toString().split(',')[0] || 
                     req?.socket.remoteAddress || 
                     undefined;
    const userAgent = req?.headers['user-agent'] || undefined;

    const auditLog = new AuditLog({
      ...logData,
      timestamp: exactTimestamp,
      ipAddress,
      userAgent,
    });

    const savedLog = await auditLog.save();
    console.log(`✅ Audit log created: ${logData.action} by ${logData.performedBy} at ${exactTimestamp.toISOString()}`);
    return savedLog;
  } catch (error: any) {
    console.error('❌ Failed to create audit log:', error?.message || error);
    return {} as IAuditLog;
  }
};

/**
 * Helper function to extract user information from res.locals.
 * 
 * @param {any} locals - res.locals object from Express
 * @returns {Object} User information for audit logging
 */
export const extractUserInfo = (locals: any) => {
  if (locals.isAdmin && locals.adminEmail) {
    return {
      performedBy: locals.adminEmail,
      performedByRole: 'cf_admin' as const,
      performedById: locals.adminId,
      performedByName: locals.adminName,
    };
  }
  
  if (locals.isCompanyAdmin && locals.companyAdminEmail) {
    return {
      performedBy: locals.companyAdminEmail,
      performedByRole: 'merchant_admin' as const,
      performedById: locals.companyAdminId,
      performedByName: locals.companyAdminName,
    };
  }
  
  if (locals.isMerchant && locals.companyName) {
    return {
      performedBy: locals.companyName,
      performedByRole: 'merchant_admin' as const,
      performedById: locals.companyId,
      performedByName: locals.companyName,
    };
  }
  
  return {
    performedBy: 'system@fulfillmate.com',
    performedByRole: 'system' as const,
  };
};

