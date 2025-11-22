import { Router, Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { verifyCFAdminToken } from '../middleware/verifyCFAdminToken';

const router = Router();

/**
 * Get audit logs with filtering and pagination.
 * 
 * Returns audit logs from auth service. Only CF Admins can access these logs.
 * 
 * Logs are immutable and cannot be modified or deleted by anyone.
 * 
 * @route GET /logs
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=50] - Number of logs per page (default: 50, max: 100)
 * @param {string} [req.query.action] - Filter by action type (e.g., 'staff_added', 'admin_removed')
 * @param {string} [req.query.performedBy] - Filter by performer email
 * @param {string} [req.query.startDate] - Filter logs from this date (ISO 8601 format)
 * @param {string} [req.query.endDate] - Filter logs until this date (ISO 8601 format)
 * 
 * @returns {Object} 200 - Paginated list of audit logs
 * @returns {Object} 403 - Access denied
 */
router.get('/logs', verifyCFAdminToken, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100); // Max 100 per page
    const skip = (page - 1) * limit;

    // Build query
    const query: any = { service: 'auth-service' };

    // Filter by action
    if (req.query.action) {
      query.action = req.query.action;
    }

    // Filter by performer
    if (req.query.performedBy) {
      query.performedBy = (req.query.performedBy as string).toLowerCase();
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

