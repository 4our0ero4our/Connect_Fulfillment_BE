import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { SupportTicket, TicketStatus, ISupportTicket } from '../models/SupportTicket';
import { Message, IMessage } from '../models/Message';
import { verifyCFAdminToken } from '../middleware/verifyCFAdminToken';
import { verifyCompanyAdminToken } from '../middleware/verifyCompanyAdminToken';
import { createAuditLog, extractUserInfo } from '../utils/auditLogger';
import { generateTicketNumber } from '../utils/ticketNumberGenerator';
import { publishTicketCreated, publishTicketStatusUpdated, publishMessageCreated } from '../utils/kafkaProducer';
import axios from 'axios';

const router = Router();
const COMPANY_SERVICE_URL = process.env.COMPANY_SERVICE_URL || 'http://company-service:4004';

const findTicketByIdentifier = async (
  ticketIdentifier: string,
  { lean = false }: { lean?: boolean } = {}
) => {
  let ticket = null;

  if (mongoose.Types.ObjectId.isValid(ticketIdentifier)) {
    const byIdQuery = SupportTicket.findById(ticketIdentifier);
    ticket = lean ? await byIdQuery.lean() : await byIdQuery;
  }

  if (!ticket) {
    const byNumberQuery = SupportTicket.findOne({ ticketNumber: ticketIdentifier });
    ticket = lean ? await byNumberQuery.lean() : await byNumberQuery;
  }

  return ticket;
};

// WebSocket broadcast functions (will be set by index.ts after initialization)
let broadcastMessageFn: ((ticketId: string, companyId: string, data: any) => void) | null = null;
let broadcastTicketStatusUpdateFn: ((ticketId: string, companyId: string, data: any) => void) | null = null;

/**
 * Sets the broadcast functions for WebSocket communication.
 * Called from index.ts after WebSocket server is initialized.
 * 
 * @param messageFn - Function to broadcast new messages
 * @param statusFn - Function to broadcast ticket status updates
 */
export const setBroadcastFunctions = (
  messageFn: (ticketId: string, companyId: string, data: any) => void,
  statusFn: (ticketId: string, companyId: string, data: any) => void
) => {
  broadcastMessageFn = messageFn;
  broadcastTicketStatusUpdateFn = statusFn;
};

/**
 * Helper middleware to allow either CF Admin or Company Admin.
 */
const verifyAdminOrMerchant = async (req: Request, res: Response, next: any) => {
  // Try CF Admin first
  const cfAdminToken = req.headers.authorization?.split(' ')[1];
  if (cfAdminToken) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(cfAdminToken, process.env.JWT_SECRET!);
      if (decoded.adminEmail) {
        // It's a CF Admin token, verify it properly
        return verifyCFAdminToken(req, res, next);
      }
    } catch {
      // Not a CF Admin token, try company admin
    }
  }

  // Try Company Admin
  return verifyCompanyAdminToken(req, res, next);
};

/**
 * Health check endpoint for the Messaging Service.
 * 
 * @route GET /
 * @returns {Object} Service status message
 */
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Messaging Service is running', service: 'messaging-service' });
});

/**
 * Create a new support ticket/conversation.
 * 
 * Merchants and CF Admins can create tickets. The creator assigns a custom name
 * (optional), and a ticket number is auto-generated. First message is included
 * in the creation request.
 * 
 * @route POST /tickets
 * @access Private (requires CF Admin token OR Company Admin token)
 * 
 * @param {string} [req.body.customName] - Optional custom name for the ticket
 * @param {string} req.body.content - First message content
 * @param {string} [req.body.category] - Ticket category (e.g., 'api_issue', 'billing')
 * @param {string} [req.body.priority] - Priority level (low, medium, high, urgent)
 * 
 * @returns {Object} 201 - Ticket created successfully with ticket details
 * @returns {Object} 400 - Validation error (missing content)
 */
router.post('/tickets', verifyAdminOrMerchant, async (req: Request, res: Response) => {
  try {
    const { customName, content, category, priority } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Message content is required'
      });
    }

    // Determine creator type and get company info
    let companyId: string;
    let companyName: string;
    let companyAdminEmail: string | undefined;
    let createdBy: {
      type: 'merchant' | 'cf_admin';
      userId: string;
      userEmail: string;
      userName: string;
    };

    if (res.locals.isAdmin || res.locals.isCFAdmin) {
      // CF Admin creating ticket
      if (!req.body.companyId) {
        return res.status(400).json({
          message: 'Validation error',
          error: 'companyId is required when CF Admin creates a ticket'
        });
      }

      // Get company info
      try {
        const response = await axios.get(`${COMPANY_SERVICE_URL}/verify-key`, {
          headers: { 'your_company_api_key': req.body.companyApiKey || '' },
          timeout: 5000,
        });
        const company = response.data?.company;
        if (!company || company._id?.toString() !== req.body.companyId) {
          return res.status(404).json({
            message: 'Company not found',
            error: 'The specified company does not exist'
          });
        }
        companyId = company._id.toString();
        companyName = company.companyName;
        companyAdminEmail = undefined;
      } catch {
        // Try to get company by ID directly (if endpoint exists)
        companyId = req.body.companyId;
        companyName = req.body.companyName || 'Unknown Company';
      }

      createdBy = {
        type: 'cf_admin',
        userId: res.locals.adminId,
        userEmail: res.locals.adminEmail,
        userName: res.locals.adminName || res.locals.adminEmail,
      };
    } else {
      // Merchant creating ticket
      companyId = res.locals.companyId;
      companyName = res.locals.companyName;
      companyAdminEmail = res.locals.companyAdminEmail;

      createdBy = {
        type: 'merchant',
        userId: res.locals.companyAdminId,
        userEmail: res.locals.companyAdminEmail,
        userName: res.locals.companyAdminName || res.locals.companyAdminEmail,
      };
    }

    // Generate ticket number
    const ticketNumber = await generateTicketNumber();

    // Create ticket
    const ticket = await SupportTicket.create({
      ticketNumber,
      customName: customName?.trim() || undefined,
      companyId,
      companyName,
      companyAdminEmail,
      createdBy,
      status: TicketStatus.OPEN,
      priority: priority || 'medium',
      category: category || undefined,
      lastMessageAt: new Date(),
      lastMessagePreview: content.substring(0, 200),
      messageCount: 1,
      unreadCount: {
        merchant: createdBy.type === 'cf_admin' ? 1 : 0,
        cfAdmin: createdBy.type === 'merchant' ? 1 : 0,
      },
    });

    // Create first message
    const message = await Message.create({
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
      senderType: createdBy.type,
      senderId: createdBy.userId,
      senderEmail: createdBy.userEmail,
      senderName: createdBy.userName,
      content: content.trim(),
      read: false,
    });

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    console.log(`[Ticket Created] Creating audit log. Company ID: ${companyId}, User: ${userInfo.performedBy}`);

    await createAuditLog({
      action: 'support_ticket_created',
      ...userInfo,
      targetTicket: ticket._id.toString(),
      targetTicketNumber: ticket.ticketNumber,
      targetCompany: companyId,
      targetCompanyName: companyName,
      details: {
        ticketNumber: ticket.ticketNumber,
        customName: ticket.customName,
        category: ticket.category,
        priority: ticket.priority,
        createdByType: createdBy.type,
      },
      service: 'messaging-service',
    }, req);

    // Publish Kafka event
    await publishTicketCreated({
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
      companyId: ticket.companyId,
      companyName: ticket.companyName,
      createdBy: {
        type: createdBy.type,
        userEmail: createdBy.userEmail,
        userName: createdBy.userName,
      },
      customName: ticket.customName,
      category: ticket.category,
      priority: ticket.priority,
      createdAt: ticket.createdAt,
    });

    // Broadcast WebSocket event
    if (broadcastTicketStatusUpdateFn) {
      broadcastTicketStatusUpdateFn(
        ticket._id.toString(),
        ticket.companyId,
        {
          ticketId: ticket._id.toString(),
          ticketNumber: ticket.ticketNumber,
          status: ticket.status,
          customName: ticket.customName,
          companyId: ticket.companyId,
          companyName: ticket.companyName,
          createdBy: ticket.createdBy,
        }
      );
    }

    res.status(201).json({
      message: 'Support ticket created successfully',
      ticket: {
        id: ticket._id,
        ticketId: ticket._id.toString(),
        ticketNumber: ticket.ticketNumber,
        customName: ticket.customName,
        companyId: ticket.companyId,
        companyName: ticket.companyName,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        createdBy: ticket.createdBy,
        messageCount: ticket.messageCount,
        unreadCount: ticket.unreadCount,
        createdAt: ticket.createdAt,
      },
      firstMessage: {
        id: message._id,
        content: message.content,
        senderType: message.senderType,
        senderName: message.senderName,
        createdAt: message.createdAt,
      },
    });
  } catch (error: any) {
    console.error('Error creating support ticket:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get all support tickets with filtering and pagination.
 * 
 * - CF Admins: Can see all tickets, filter by company, status, assigned admin
 * - Merchants: Can only see their own company's tickets
 * 
 * @route GET /tickets
 * @access Private (requires CF Admin token OR Company Admin token)
 * 
 * @param {number} [req.query.page=1] - Page number
 * @param {number} [req.query.limit=20] - Items per page
 * @param {string} [req.query.status] - Filter by status
 * @param {string} [req.query.companyId] - Filter by company (CF Admin only)
 * @param {string} [req.query.assignedTo] - Filter by assigned CF admin email
 * @param {string} [req.query.search] - Search by ticket number or custom name
 * 
 * @returns {Object} 200 - Paginated list of tickets
 */
router.get('/tickets', verifyAdminOrMerchant, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const skip = (page - 1) * limit;

    const query: any = {};

    // Merchants can only see their company's tickets
    if (res.locals.isCompanyAdmin || res.locals.isMerchant) {
      query.companyId = res.locals.companyId;
    }

    // CF Admins can filter by company
    if (req.query.companyId && (res.locals.isAdmin || res.locals.isCFAdmin)) {
      query.companyId = req.query.companyId;
    }

    // Filter by status
    if (req.query.status && Object.values(TicketStatus).includes(req.query.status as TicketStatus)) {
      query.status = req.query.status;
    }

    // Filter by assigned admin
    if (req.query.assignedTo && (res.locals.isAdmin || res.locals.isCFAdmin)) {
      query['assignedTo.cfAdminEmail'] = (req.query.assignedTo as string).toLowerCase();
    }

    // Search by ticket number or custom name
    if (req.query.search) {
      const searchTerm = (req.query.search as string).trim();
      query.$or = [
        { ticketNumber: { $regex: searchTerm, $options: 'i' } },
        { customName: { $regex: searchTerm, $options: 'i' } },
      ];
    }

    const totalTickets = await SupportTicket.countDocuments(query);

    const tickets = await SupportTicket.find(query)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.status(200).json({
      message: 'Support tickets retrieved successfully',
      tickets: tickets.map(ticket => {
        const normalizedId = ticket._id?.toString?.() ?? ticket._id;
        return {
          id: normalizedId,
          ticketId: normalizedId,
          ticketNumber: ticket.ticketNumber,
          customName: ticket.customName,
          displayName: ticket.customName || ticket.ticketNumber,
          companyId: ticket.companyId,
          companyName: ticket.companyName,
          status: ticket.status,
          priority: ticket.priority,
          category: ticket.category,
          createdBy: ticket.createdBy,
          assignedTo: ticket.assignedTo,
          lastMessageAt: ticket.lastMessageAt,
          lastMessagePreview: ticket.lastMessagePreview,
          messageCount: ticket.messageCount,
          unreadCount: ticket.unreadCount,
          resolvedAt: ticket.resolvedAt,
          closedAt: ticket.closedAt,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
        };
      }),
      pagination: {
        page,
        limit,
        total: totalTickets,
        totalPages: Math.ceil(totalTickets / limit),
        hasNextPage: page < Math.ceil(totalTickets / limit),
        hasPrevPage: page > 1,
      },
    });
  } catch (error: any) {
    console.error('Error retrieving support tickets:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get a single support ticket with all messages.
 * 
 * @route GET /tickets/:ticketId
 * @access Private (requires CF Admin token OR Company Admin token)
 * 
 * @param {string} req.params.ticketId - MongoDB ObjectId of the ticket
 * @param {number} [req.query.page=1] - Page number for messages
 * @param {number} [req.query.limit=50] - Messages per page
 * 
 * @returns {Object} 200 - Ticket details with messages
 * @returns {Object} 403 - Access denied (merchant trying to access another company's ticket)
 * @returns {Object} 404 - Ticket not found
 */
router.get('/tickets/:ticketId', verifyAdminOrMerchant, async (req: Request, res: Response) => {
  try {
    const ticketIdentifier = req.params.ticketId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const skip = (page - 1) * limit;

    const ticket = await findTicketByIdentifier(ticketIdentifier, { lean: true });

    if (!ticket) {
      return res.status(404).json({
        message: 'Support ticket not found',
        error: 'The ticket you are looking for does not exist'
      });
    }

    // Check access control for merchants
    if (res.locals.isCompanyAdmin || res.locals.isMerchant) {
      if (ticket.companyId !== res.locals.companyId) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'You can only view tickets for your own company'
        });
      }
    }

    const normalizedTicketId = ticket._id?.toString?.() ?? ticket._id;

    // Get messages
    const totalMessages = await Message.countDocuments({ ticketId: normalizedTicketId });
    const messages = await Message.find({ ticketId: normalizedTicketId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.status(200).json({
      message: 'Support ticket retrieved successfully',
      ticket: {
        id: normalizedTicketId,
        ticketId: normalizedTicketId,
        ticketNumber: ticket.ticketNumber,
        customName: ticket.customName,
        displayName: ticket.customName || ticket.ticketNumber,
        companyId: ticket.companyId,
        companyName: ticket.companyName,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        createdBy: ticket.createdBy,
        assignedTo: ticket.assignedTo,
        lastMessageAt: ticket.lastMessageAt,
        messageCount: ticket.messageCount,
        unreadCount: ticket.unreadCount,
        resolvedAt: ticket.resolvedAt,
        closedAt: ticket.closedAt,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
      },
      messages: messages.reverse().map(msg => ({
        id: msg._id,
        content: msg.content,
        senderType: msg.senderType,
        senderId: msg.senderId,
        senderEmail: msg.senderEmail,
        senderName: msg.senderName,
        read: msg.read,
        readAt: msg.readAt,
        attachments: msg.attachments || [],
        createdAt: msg.createdAt,
      })),
      pagination: {
        page,
        limit,
        total: totalMessages,
        totalPages: Math.ceil(totalMessages / limit),
        hasNextPage: page < Math.ceil(totalMessages / limit),
        hasPrevPage: page > 1,
      },
    });
  } catch (error: any) {
    console.error('Error retrieving support ticket:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Send a message in a support ticket.
 * 
 * @route POST /tickets/:ticketId/messages
 * @access Private (requires CF Admin token OR Company Admin token)
 * 
 * @param {string} req.params.ticketId - MongoDB ObjectId of the ticket
 * @param {string} req.body.content - Message content
 * @param {Array} [req.body.attachments] - Optional file attachments
 * 
 * @returns {Object} 201 - Message sent successfully
 * @returns {Object} 400 - Validation error (missing content)
 * @returns {Object} 403 - Access denied or ticket closed
 * @returns {Object} 404 - Ticket not found
 */
router.post('/tickets/:ticketId/messages', verifyAdminOrMerchant, async (req: Request, res: Response) => {
  try {
    const ticketId = req.params.ticketId;
    const { content, attachments } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Message content is required'
      });
    }

    const ticket = await findTicketByIdentifier(ticketId);

    if (!ticket) {
      return res.status(404).json({
        message: 'Support ticket not found',
        error: 'The ticket you are looking for does not exist'
      });
    }

    // Check access control for merchants
    if (res.locals.isCompanyAdmin || res.locals.isMerchant) {
      if (ticket.companyId !== res.locals.companyId) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'You can only send messages to tickets for your own company'
        });
      }
    }

    // Check if ticket is closed
    if (ticket.status === TicketStatus.CLOSED) {
      return res.status(403).json({
        message: 'Ticket is closed',
        error: 'Cannot send messages to a closed ticket'
      });
    }

    // Determine sender
    let senderType: 'merchant' | 'cf_admin';
    let senderId: string;
    let senderEmail: string;
    let senderName: string;

    if (res.locals.isAdmin || res.locals.isCFAdmin) {
      senderType = 'cf_admin';
      senderId = res.locals.adminId;
      senderEmail = res.locals.adminEmail;
      senderName = res.locals.adminName || res.locals.adminEmail;
    } else {
      senderType = 'merchant';
      senderId = res.locals.companyAdminId;
      senderEmail = res.locals.companyAdminEmail;
      senderName = res.locals.companyAdminName || res.locals.companyAdminEmail;
    }

    // Create message
    const normalizedTicketId = ticket._id.toString();
    const message = await Message.create({
      ticketId: normalizedTicketId,
      ticketNumber: ticket.ticketNumber,
      senderType,
      senderId,
      senderEmail,
      senderName,
      content: content.trim(),
      read: false,
      attachments: attachments || [],
    });

    // Update ticket
    ticket.lastMessageAt = new Date();
    ticket.lastMessagePreview = content.trim().substring(0, 200);
    ticket.messageCount += 1;

    // Update unread counts
    if (senderType === 'merchant') {
      ticket.unreadCount.cfAdmin += 1;
    } else {
      ticket.unreadCount.merchant += 1;
    }

    // Auto-assign to CF admin if not assigned and CF admin is replying
    if (senderType === 'cf_admin' && !ticket.assignedTo) {
      ticket.assignedTo = {
        cfAdminId: res.locals.adminId,
        cfAdminEmail: res.locals.adminEmail,
        cfAdminName: res.locals.adminName || res.locals.adminEmail,
        assignedAt: new Date(),
      };
      if (ticket.status === TicketStatus.OPEN) {
        ticket.status = TicketStatus.ASSIGNED;
      }
    }

    await ticket.save();

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'message_sent',
      ...userInfo,
      targetTicket: ticket._id.toString(),
      targetTicketNumber: ticket.ticketNumber,
      targetCompany: ticket.companyId,
      targetCompanyName: ticket.companyName,
      details: {
        messageId: message._id.toString(),
        senderType,
        ticketStatus: ticket.status,
      },
      service: 'messaging-service',
    }, req);

    // Publish Kafka event
    await publishMessageCreated({
      messageId: message._id.toString(),
      ticketId: ticket._id.toString(),
      ticketNumber: ticket.ticketNumber,
      companyId: ticket.companyId,
      companyName: ticket.companyName,
      senderType,
      senderEmail,
      senderName,
      content: message.content,
      createdAt: message.createdAt,
    });

    // Broadcast WebSocket event
    if (broadcastMessageFn) {
      broadcastMessageFn(
        normalizedTicketId,
        ticket.companyId,
        {
          messageId: message._id.toString(),
          ticketId: normalizedTicketId,
          ticketNumber: ticket.ticketNumber,
          content: message.content,
          senderType,
          senderEmail,
          senderName,
          createdAt: message.createdAt,
          unreadCount: ticket.unreadCount,
        }
      );
    }

    res.status(201).json({
      message: 'Message sent successfully',
      messageData: {
        id: message._id,
        content: message.content,
        senderType: message.senderType,
        senderName: message.senderName,
        read: message.read,
        attachments: message.attachments,
        createdAt: message.createdAt,
      },
      ticket: {
        id: normalizedTicketId,
        ticketId: normalizedTicketId,
        status: ticket.status,
        assignedTo: ticket.assignedTo,
        unreadCount: ticket.unreadCount,
      },
    });
  } catch (error: any) {
    console.error('Error sending message:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Update ticket status (assign, resolve, close).
 * 
 * @route PATCH /tickets/:ticketId/status
 * @access Private (requires CF Admin token OR Company Admin token)
 * 
 * @param {string} req.params.ticketId - MongoDB ObjectId of the ticket
 * @param {string} req.body.status - New status (assigned, in_progress, resolved, closed)
 * @param {string} [req.body.assignedToEmail] - CF Admin email to assign ticket to (CF Admin only)
 * 
 * @returns {Object} 200 - Ticket status updated successfully
 * @returns {Object} 400 - Validation error (invalid status)
 * @returns {Object} 403 - Access denied
 * @returns {Object} 404 - Ticket not found
 */
router.patch('/tickets/:ticketId/status', verifyAdminOrMerchant, async (req: Request, res: Response) => {
  try {
    const ticketId = req.params.ticketId;
    const { status, assignedToEmail } = req.body;

    if (!status || !Object.values(TicketStatus).includes(status)) {
      return res.status(400).json({
        message: 'Validation error',
        error: `Invalid status. Must be one of: ${Object.values(TicketStatus).join(', ')}`
      });
    }

    const ticket = await findTicketByIdentifier(ticketId);

    if (!ticket) {
      return res.status(404).json({
        message: 'Support ticket not found',
        error: 'The ticket you are looking for does not exist'
      });
    }

    // Check access control
    if (res.locals.isCompanyAdmin || res.locals.isMerchant) {
      if (ticket.companyId !== res.locals.companyId) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'You can only update tickets for your own company'
        });
      }

      // Merchants can only close or resolve their own tickets
      if (status === TicketStatus.ASSIGNED || status === TicketStatus.IN_PROGRESS) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'Only CF Admins can assign tickets or mark them as in progress'
        });
      }
    }

    const oldStatus = ticket.status;
    const oldAssignedTo = ticket.assignedTo ? { ...ticket.assignedTo } : undefined;

    // Update status
    ticket.status = status as TicketStatus;

    // Handle assignment (CF Admin only)
    if (assignedToEmail && (res.locals.isAdmin || res.locals.isCFAdmin)) {
      // Verify assigned admin exists (simplified - in production, verify against auth service)
      ticket.assignedTo = {
        cfAdminId: req.body.assignedToId || 'unknown',
        cfAdminEmail: assignedToEmail.toLowerCase(),
        cfAdminName: req.body.assignedToName || assignedToEmail,
        assignedAt: new Date(),
      };

      if (status === TicketStatus.OPEN) {
        ticket.status = TicketStatus.ASSIGNED;
      }
    }

    // Handle status-specific updates
    if (status === TicketStatus.RESOLVED && !ticket.resolvedAt) {
      ticket.resolvedAt = new Date();
    }

    if (status === TicketStatus.CLOSED) {
      ticket.closedAt = new Date();
      ticket.closedBy = {
        type: res.locals.isAdmin ? 'cf_admin' : 'merchant',
        userId: res.locals.isAdmin ? res.locals.adminId : res.locals.companyAdminId,
        userEmail: res.locals.isAdmin ? res.locals.adminEmail : res.locals.companyAdminEmail,
      };
    }

    await ticket.save();

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'support_ticket_status_updated',
      ...userInfo,
      targetTicket: ticket._id.toString(),
      targetTicketNumber: ticket.ticketNumber,
      targetCompany: ticket.companyId,
      targetCompanyName: ticket.companyName,
      details: {
        oldStatus,
        newStatus: status,
        oldAssignedTo: oldAssignedTo?.cfAdminEmail,
        newAssignedTo: ticket.assignedTo?.cfAdminEmail,
      },
      service: 'messaging-service',
    }, req);

    // Publish Kafka event
    const normalizedTicketId = ticket._id.toString();
    await publishTicketStatusUpdated({
      ticketId: normalizedTicketId,
      ticketNumber: ticket.ticketNumber,
      companyId: ticket.companyId,
      companyName: ticket.companyName,
      oldStatus,
      newStatus: status,
      updatedBy: {
        type: res.locals.isAdmin ? 'cf_admin' : 'merchant',
        userEmail: res.locals.isAdmin ? res.locals.adminEmail : res.locals.companyAdminEmail,
        userName: res.locals.isAdmin ? res.locals.adminName : res.locals.companyAdminName,
      },
      assignedTo: ticket.assignedTo ? {
        cfAdminEmail: ticket.assignedTo.cfAdminEmail,
        cfAdminName: ticket.assignedTo.cfAdminName,
      } : undefined,
      updatedAt: ticket.updatedAt,
    });

    // Broadcast WebSocket event
    if (broadcastTicketStatusUpdateFn) {
      broadcastTicketStatusUpdateFn(
        normalizedTicketId,
        ticket.companyId,
        {
          ticketId: normalizedTicketId,
          ticketNumber: ticket.ticketNumber,
          oldStatus,
          newStatus: status,
          assignedTo: ticket.assignedTo,
          resolvedAt: ticket.resolvedAt,
          closedAt: ticket.closedAt,
        }
      );
    }

    res.status(200).json({
      message: 'Ticket status updated successfully',
      ticket: {
        id: normalizedTicketId,
        ticketId: normalizedTicketId,
        ticketNumber: ticket.ticketNumber,
        status: ticket.status,
        assignedTo: ticket.assignedTo,
        resolvedAt: ticket.resolvedAt,
        closedAt: ticket.closedAt,
        closedBy: ticket.closedBy,
        updatedAt: ticket.updatedAt,
      },
    });
  } catch (error: any) {
    console.error('Error updating ticket status:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Mark messages as read in a ticket.
 * 
 * @route PATCH /tickets/:ticketId/messages/read
 * @access Private (requires CF Admin token OR Company Admin token)
 * 
 * @param {string} req.params.ticketId - MongoDB ObjectId of the ticket
 * 
 * @returns {Object} 200 - Messages marked as read
 */
router.patch('/tickets/:ticketId/messages/read', verifyAdminOrMerchant, async (req: Request, res: Response) => {
  try {
    const ticketIdentifier = req.params.ticketId;

    const ticket = await findTicketByIdentifier(ticketIdentifier);

    if (!ticket) {
      return res.status(404).json({
        message: 'Support ticket not found',
        error: 'The ticket you are looking for does not exist'
      });
    }

    // Check access control
    if (res.locals.isCompanyAdmin || res.locals.isMerchant) {
      if (ticket.companyId !== res.locals.companyId) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'You can only mark messages as read for your own company\'s tickets'
        });
      }
    }

    // Determine reader type
    const readerType = res.locals.isAdmin ? 'cf_admin' : 'merchant';
    const readerEmail = res.locals.isAdmin ? res.locals.adminEmail : res.locals.companyAdminEmail;

    const normalizedTicketId = ticket._id.toString();

    // Mark unread messages as read
    const updateResult = await Message.updateMany(
      {
        ticketId: normalizedTicketId,
        read: false,
        senderType: readerType === 'cf_admin' ? 'merchant' : 'cf_admin', // Mark opposite sender's messages as read
      },
      {
        $set: {
          read: true,
          readAt: new Date(),
        },
        $push: {
          readBy: {
            userId: res.locals.isAdmin ? res.locals.adminId : res.locals.companyAdminId,
            userEmail: readerEmail,
            readAt: new Date(),
          },
        },
      }
    );

    // Update ticket unread count
    if (readerType === 'cf_admin') {
      ticket.unreadCount.cfAdmin = 0;
    } else {
      ticket.unreadCount.merchant = 0;
    }

    await ticket.save();

    res.status(200).json({
      message: 'Messages marked as read',
      updatedCount: updateResult.modifiedCount,
      unreadCount: ticket.unreadCount,
    });
  } catch (error: any) {
    console.error('Error marking messages as read:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get ticket log/audit trail (CF Admin only).
 * 
 * Shows all tickets with their status history for CF admins to track ticket activity.
 * 
 * @route GET /tickets/log
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {number} [req.query.page=1] - Page number
 * @param {number} [req.query.limit=50] - Items per page
 * @param {string} [req.query.status] - Filter by status
 * @param {string} [req.query.companyId] - Filter by company
 * 
 * @returns {Object} 200 - Ticket log with status information
 */
router.get('/tickets/log', verifyCFAdminToken, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const skip = (page - 1) * limit;

    const query: any = {};

    if (req.query.status && Object.values(TicketStatus).includes(req.query.status as TicketStatus)) {
      query.status = req.query.status;
    }

    if (req.query.companyId) {
      query.companyId = req.query.companyId;
    }

    const totalTickets = await SupportTicket.countDocuments(query);

    const tickets = await SupportTicket.find(query)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('ticketNumber customName companyId companyName status priority category createdBy assignedTo resolvedAt closedAt closedBy createdAt updatedAt lastMessageAt')
      .lean();

    res.status(200).json({
      message: 'Ticket log retrieved successfully',
      tickets: tickets.map(ticket => {
        const normalizedId = ticket._id?.toString?.() ?? ticket._id;
        return {
          id: normalizedId,
          ticketId: normalizedId,
          ticketNumber: ticket.ticketNumber,
          displayName: ticket.customName || ticket.ticketNumber,
          companyId: ticket.companyId,
          companyName: ticket.companyName,
          status: ticket.status,
          priority: ticket.priority,
          category: ticket.category,
          createdBy: {
            type: ticket.createdBy.type,
            userEmail: ticket.createdBy.userEmail,
            userName: ticket.createdBy.userName,
            createdAt: ticket.createdAt,
          },
          assignedTo: ticket.assignedTo ? {
            cfAdminEmail: ticket.assignedTo.cfAdminEmail,
            cfAdminName: ticket.assignedTo.cfAdminName,
            assignedAt: ticket.assignedTo.assignedAt,
          } : null,
          resolvedAt: ticket.resolvedAt,
          closedAt: ticket.closedAt,
          closedBy: ticket.closedBy,
          lastMessageAt: ticket.lastMessageAt,
          updatedAt: ticket.updatedAt,
        };
      }),
      pagination: {
        page,
        limit,
        total: totalTickets,
        totalPages: Math.ceil(totalTickets / limit),
        hasNextPage: page < Math.ceil(totalTickets / limit),
        hasPrevPage: page > 1,
      },
    });
  } catch (error: any) {
    console.error('Error retrieving ticket log:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

export default router;

