import { Router, Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { verifyAdminOrCompanyAdmin } from '../middleware/verifyAdminOrCompanyAdmin';

const router = Router();

/**
 * Get audit logs with filtering and pagination.
 * 
 * Returns audit logs based on the requester's role:
 * - CF Admins: Can see all logs from all services, filter by company, action, date range, performedBy
 * - Company Admins/Merchant Admins: Can only see logs where:
 *   - performedBy matches their email (their own actions), OR
 *   - targetCompany matches their company ID (actions affecting their company)
 * 
 * Logs are immutable and cannot be modified or deleted by anyone.
 * 
 * @route GET /logs
 * @access Private (requires CF Admin token OR Company Admin token)
 * 
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=50] - Number of logs per page (default: 50, max: 100)
 * @param {string} [req.query.companyId] - Filter by company ID (CF Admin only)
 * @param {string} [req.query.action] - Filter by action type (e.g., 'company_verified', 'admin_added')
 * @param {string} [req.query.performedBy] - Filter by performer email (CF Admin can filter any, Company Admin can only filter their own)
 * @param {string} [req.query.startDate] - Filter logs from this date (ISO 8601 format)
 * @param {string} [req.query.endDate] - Filter logs until this date (ISO 8601 format)
 * @param {string} [req.query.service] - Filter by service (e.g., 'company-service', 'order-service', 'auth-service')
 * 
 * @returns {Object} 200 - Paginated list of audit logs
 * @returns {Object} 403 - Access denied
 */
router.get('/logs', verifyAdminOrCompanyAdmin, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100); // Max 100 per page
    const skip = (page - 1) * limit;

    // Build query
    const query: any = {};

    // Service filter - default to company-service if not specified, but CF Admin can see all services
    if (req.query.service) {
      query.service = req.query.service;
    } else if (res.locals.isCompanyAdmin) {
      // Company Admin defaults to company-service only
      query.service = 'company-service';
    }
    // CF Admin can see all services if no filter specified

    // Access control: Company Admin can only see their own logs or their company's logs
    if (res.locals.isCompanyAdmin) {
      const companyAdminEmail = res.locals.companyAdminEmail?.toLowerCase();
      const companyId = res.locals.companyId;

      // Company Admin can see:
      // 1. Logs where they performed the action (performedBy = their email)
      // 2. Logs where their company is the target (targetCompany = their companyId)
      query.$or = [
        { performedBy: companyAdminEmail },
        { targetCompany: companyId }
      ];

      // If they filter by performedBy, ensure it's their own email
      if (req.query.performedBy) {
        const requestedEmail = (req.query.performedBy as string).toLowerCase();
        if (requestedEmail !== companyAdminEmail) {
          return res.status(403).json({
            message: 'Access denied',
            error: 'You can only view audit logs for your own actions or your company'
          });
        }
        // Override the $or with just performedBy filter
        query.$or = [{ performedBy: companyAdminEmail }];
      }
    } else if (res.locals.isCFAdmin) {
      // CF Admin can see all logs, but can filter
      // Filter by company ID (CF Admin only)
      if (req.query.companyId) {
        query.targetCompany = req.query.companyId;
      }
    }

    // Filter by action
    if (req.query.action) {
      query.action = req.query.action;
    }

    // Filter by performer (CF Admin can filter any, Company Admin already handled above)
    if (req.query.performedBy && res.locals.isCFAdmin) {
      query.performedBy = (req.query.performedBy as string).toLowerCase();
      // Remove $or if CF Admin filters by performedBy
      if (query.$or) {
        delete query.$or;
      }
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

export default router;

