import { Router, Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { verifyCFAdmin, verifyAdminOrMerchant } from '../middleware/orderAccessControl';

const router = Router();

/**
 * Get audit logs with filtering and pagination.
 * 
 * Returns audit logs based on the requester's role:
 * - CF Admins: Can see all logs, filter by company, action, date range
 * - Merchants/Company Admins: Can only see logs for their own company
 * 
 * Logs are immutable and cannot be modified or deleted by anyone.
 * 
 * @route GET /logs
 * @access Private (requires CF Admin token OR Company Admin token OR Company API key)
 * 
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=50] - Number of logs per page (default: 50, max: 100)
 * @param {string} [req.query.companyId] - Filter by company ID (CF Admin only)
 * @param {string} [req.query.action] - Filter by action type (e.g., 'order_created', 'company_verified')
 * @param {string} [req.query.performedBy] - Filter by performer email
 * @param {string} [req.query.startDate] - Filter logs from this date (ISO 8601 format)
 * @param {string} [req.query.endDate] - Filter logs until this date (ISO 8601 format)
 * @param {string} [req.query.service] - Filter by service (e.g., 'order-service', 'company-service')
 * 
 * @returns {Object} 200 - Paginated list of audit logs
 * @returns {Object} 403 - Access denied
 */
router.get('/logs', verifyAdminOrMerchant, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100); // Max 100 per page
    const skip = (page - 1) * limit;

    // Build query
    const query: any = {};

    // Company Admin/Merchant can only see their own company's logs
    if (res.locals.isMerchant || res.locals.isCompanyAdmin) {
      query.targetCompany = res.locals.companyId;
    }
    // CF Admin can see all logs (no companyId filter unless specified)

    // Filter by company ID (CF Admin only)
    if (req.query.companyId && (res.locals.isAdmin || res.locals.isCFAdmin)) {
      query.targetCompany = req.query.companyId;
    }

    // Filter by action
    if (req.query.action) {
      query.action = req.query.action;
    }

    // Filter by performer
    if (req.query.performedBy) {
      query.performedBy = (req.query.performedBy as string).toLowerCase();
    }

    // Filter by service
    if (req.query.service) {
      query.service = req.query.service;
    }

    // Filter by date range
    if (req.query.startDate || req.query.endDate) {
      query.timestamp = {};
      if (req.query.startDate) {
        query.timestamp.$gte = new Date(req.query.startDate as string);
      }
      if (req.query.endDate) {
        query.timestamp.$lte = new Date(req.query.endDate as string);
      }
    }

    // Get total count for pagination
    const totalLogs = await AuditLog.countDocuments(query);

    // Get logs with pagination, sorted by most recent first
    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.status(200).json({
      message: 'Audit logs retrieved successfully',
      logs: logs.map(log => ({
        id: log._id,
        action: log.action,
        performedBy: log.performedBy,
        performedByRole: log.performedByRole,
        performedById: log.performedById,
        performedByName: log.performedByName,
        targetCompany: log.targetCompany,
        targetCompanyName: log.targetCompanyName,
        targetOrder: log.targetOrder,
        targetOrderNumber: log.targetOrderNumber,
        targetTicket: log.targetTicket,
        targetAdmin: log.targetAdmin,
        targetStaff: log.targetStaff,
        details: log.details,
        timestamp: log.timestamp, // Exact date and time
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        service: log.service,
      })),
      pagination: {
        page,
        limit,
        total: totalLogs,
        totalPages: Math.ceil(totalLogs / limit),
        hasNextPage: page < Math.ceil(totalLogs / limit),
        hasPrevPage: page > 1,
      },
    });
  } catch (error: any) {
    console.error('Error retrieving audit logs:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred',
    });
  }
});

/**
 * Get a single audit log by ID.
 * 
 * Returns a specific audit log entry. Access control applies:
 * - CF Admins: Can view any log
 * - Merchants/Company Admins: Can only view logs for their own company
 * 
 * @route GET /logs/:logId
 * @access Private (requires CF Admin token OR Company Admin token OR Company API key)
 * 
 * @param {string} req.params.logId - MongoDB ObjectId of the audit log
 * 
 * @returns {Object} 200 - Audit log details
 * @returns {Object} 403 - Access denied (merchant trying to view another company's log)
 * @returns {Object} 404 - Log not found
 */
router.get('/logs/:logId', verifyAdminOrMerchant, async (req: Request, res: Response) => {
  try {
    const logId = req.params.logId;
    const log = await AuditLog.findById(logId).lean();

    if (!log) {
      return res.status(404).json({
        message: 'Audit log not found',
        error: 'The log you are looking for does not exist',
      });
    }

    // Check access control for merchants
    if (res.locals.isMerchant || res.locals.isCompanyAdmin) {
      if (log.targetCompany !== res.locals.companyId) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'You can only view audit logs for your own company',
        });
      }
    }

    res.status(200).json({
      message: 'Audit log retrieved successfully',
      log: {
        id: log._id,
        action: log.action,
        performedBy: log.performedBy,
        performedByRole: log.performedByRole,
        performedById: log.performedById,
        performedByName: log.performedByName,
        targetCompany: log.targetCompany,
        targetCompanyName: log.targetCompanyName,
        targetOrder: log.targetOrder,
        targetOrderNumber: log.targetOrderNumber,
        targetTicket: log.targetTicket,
        targetAdmin: log.targetAdmin,
        targetStaff: log.targetStaff,
        details: log.details,
        timestamp: log.timestamp, // Exact date and time
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        service: log.service,
      },
    });
  } catch (error: any) {
    console.error('Error retrieving audit log:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred',
    });
  }
});

export default router;

