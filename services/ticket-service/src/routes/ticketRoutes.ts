
import { Router, Request, Response } from 'express';
import { Ticket, TicketStatus } from '../models/Ticket';
import {
  requireCFAdmin,
  requireAdminOrCompany,
  requireCompanyContext,
  requireInternalService,
} from '../middleware/accessControl';
import { createTicket, validateTicketAndMarkUsed } from '../services/ticketService';
import { getTicketCache, setTicketCache, isTicketAlreadyUsed } from '../utils/cache';

const router = Router();

/**
 * Health check endpoint for the Ticket Service.
 * Returns a simple status message to confirm the service is running.
 * 
 * @route GET /
 * @returns {Object} Service status message
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Ticket Service is running', service: 'ticket-service' });
});

/**
 * Create a new QR ticket for an order (Internal service only).
 * 
 * Generates a QR ticket when an order status changes to "packed". This endpoint
 * is called by the Ticket Service's Kafka consumer. Creates ticket with QR code
 * and publishes ticket_generated event to Kafka for notification dispatch.
 * 
 * @route POST /tickets
 * @access Internal (requires INTERNAL_SERVICE_TOKEN)
 * 
 * @param {string} req.body.orderId - MongoDB ObjectId of the order
 * @param {string} req.body.orderNumber - Order number for display
 * @param {string} req.body.companyId - Company ID that owns the order
 * @param {string} req.body.companyName - Company name
 * @param {string} [req.body.companyApiKey] - Company API key
 * @param {string} [req.body.companyEmail] - Company email
 * @param {Object} req.body.customerInfo - Customer details (customerName, customerEmail, customerPhone)
 * @param {Array} [req.body.items] - Order items array
 * @param {number} [req.body.totalAmount] - Total order amount
 * @param {string} [req.body.currency] - Currency code (default: 'NGN')
 * @param {Date} [req.body.expiresAt] - Ticket expiration date
 * 
 * @returns {Object} 201 - Ticket created successfully with ticket details and QR code
 * @returns {Object} 400 - Validation error (missing required fields)
 */
router.post('/tickets', requireInternalService, async (req: Request, res: Response) => {
  try {
    const { orderId, orderNumber, companyId, companyName, companyApiKey, companyEmail, customerInfo, items, totalAmount, currency, expiresAt } =
      req.body || {};

    if (!orderId || !companyId || !companyName || !customerInfo?.customerEmail || !customerInfo?.customerName) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'orderId, companyId, companyName and customerInfo (name & email) are required',
      });
    }

    const ticket = await createTicket({
      orderId,
      orderNumber,
      companyId,
      companyName,
      companyApiKey,
      companyEmail,
      customerInfo,
      items,
      totalAmount,
      currency,
      expiresAt,
    });

    return res.status(201).json({
      message: 'Ticket generated successfully',
      ticket,
    });
  } catch (error) {
    console.error('Error creating ticket:', (error as any)?.message);
    return res.status(500).json({
      message: 'Internal server error',
      error: (error as any)?.message || 'Failed to create ticket',
    });
  }
});

/**
 * Get a ticket by its ID.
 * 
 * Returns detailed ticket information including QR code and status. CF Admins
 * can access any ticket, while Company Admins can only access tickets from
 * their own company.
 * 
 * @route GET /tickets/:ticketId
 * @access Private (requires CF Admin token OR Company Admin token)
 * 
 * @param {string} req.params.ticketId - Unique ticket ID
 * 
 * @returns {Object} 200 - Ticket details
 * @returns {Object} 403 - Access denied (ticket belongs to different company)
 * @returns {Object} 404 - Ticket not found
 */
router.get('/tickets/:ticketId', requireAdminOrCompany, async (req: Request, res: Response) => {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    if (!res.locals.isAdmin) {
      const companyId = res.locals.companyId?.toString();
      if (ticket.companyId !== companyId) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'This ticket does not belong to your company',
        });
      }
    }

    return res.status(200).json({ ticket });
  } catch (error) {
    console.error('Error fetching ticket:', (error as any)?.message);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * Get a ticket by its associated order ID.
 * 
 * Retrieves the ticket linked to a specific order. Useful for looking up
 * tickets when you only have the order ID. Access control same as GET /tickets/:ticketId.
 * 
 * @route GET /tickets/order/:orderId
 * @access Private (requires CF Admin token OR Company Admin token)
 * 
 * @param {string} req.params.orderId - MongoDB ObjectId of the order
 * 
 * @returns {Object} 200 - Ticket details
 * @returns {Object} 403 - Access denied (ticket belongs to different company)
 * @returns {Object} 404 - Ticket not found for this order
 */
router.get('/tickets/order/:orderId', requireAdminOrCompany, async (req: Request, res: Response) => {
  try {
    const ticket = await Ticket.findOne({ orderId: req.params.orderId });
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found for this order' });
    }

    if (!res.locals.isAdmin) {
      const companyId = res.locals.companyId?.toString();
      if (ticket.companyId !== companyId) {
        return res.status(403).json({
          message: 'Access denied',
          error: 'This ticket does not belong to your company',
        });
      }
    }

    return res.status(200).json({ ticket });
  } catch (error) {
    console.error('Error fetching ticket by order:', (error as any)?.message);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * Update a ticket (CF Admin only).
 * 
 * Allows CF Admins to modify ticket properties such as status, expiration date,
 * customer information, metadata, or regenerate QR code. Useful for edge cases
 * like ticket corruption or customer information updates.
 * 
 * @route PATCH /tickets/:ticketId
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.params.ticketId - Unique ticket ID
 * @param {string} [req.body.status] - New ticket status (pending, active, completed, cancelled, expired, invalid)
 * @param {Date} [req.body.expiresAt] - New expiration date
 * @param {Object} [req.body.issuedTo] - Updated customer information (customerName, customerEmail, customerPhone)
 * @param {Object} [req.body.metadata] - Additional metadata to merge with existing metadata
 * @param {boolean} [req.body.replaceQRCode] - Whether to regenerate the QR code
 * 
 * @returns {Object} 200 - Ticket updated successfully
 * @returns {Object} 400 - Validation error (invalid status)
 * @returns {Object} 404 - Ticket not found
 */
router.patch('/tickets/:ticketId', requireCFAdmin, async (req: Request, res: Response) => {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.ticketId });
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    const { status, expiresAt, issuedTo, metadata, replaceQRCode } = req.body;

    if (status) {
      if (!Object.values(TicketStatus).includes(status)) {
        return res.status(400).json({
          message: 'Validation error',
          error: `Status must be one of: ${Object.values(TicketStatus).join(', ')}`,
        });
      }
      ticket.status = status;
    }

    if (expiresAt) {
      ticket.expiresAt = new Date(expiresAt);
    }

    if (issuedTo) {
      ticket.issuedTo = {
        customerName: issuedTo.customerName || ticket.issuedTo.customerName,
        customerEmail: issuedTo.customerEmail || ticket.issuedTo.customerEmail,
        customerPhone: issuedTo.customerPhone || ticket.issuedTo.customerPhone,
      };
    }

    if (metadata) {
      ticket.metadata = { ...(ticket.metadata || {}), ...metadata };
    }

    if (replaceQRCode) {
      const payload = JSON.stringify({
        t: ticket.ticketId,
        o: ticket.orderId,
        c: ticket.companyId,
        replacedAt: new Date().toISOString(),
      });
      ticket.qrPayload = payload;
      ticket.qrCode = Buffer.from(payload).toString('base64');
    }

    await ticket.save();
    await setTicketCache(ticket.ticketId, {
      status: ticket.status,
      orderId: ticket.orderId,
      companyId: ticket.companyId,
      expiresAt: ticket.expiresAt,
    });

    return res.status(200).json({ message: 'Ticket updated successfully', ticket });
  } catch (error) {
    console.error('Error updating ticket:', (error as any)?.message);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * Validate a ticket and mark it as used.
 * 
 * Validates a ticket when scanned at pickup. Accepts either ticketId or QR code
 * (base64 encoded). Checks ticket status, expiration, and company ownership.
 * Marks ticket as completed and publishes ticket_validated event to Kafka.
 * Tickets can only be validated once.
 * 
 * @route POST /validate
 * @access Private (requires Company Admin token OR Company API key)
 * 
 * @param {string} [req.body.ticketId] - Ticket ID (alternative to qrCode)
 * @param {string} [req.body.qrCode] - Base64 encoded QR code payload (alternative to ticketId)
 * @param {string} [req.body.location] - Location where ticket was validated
 * @param {string} [req.body.notes] - Optional validation notes
 * 
 * @returns {Object} 200 - Ticket validated successfully
 * @returns {Object} 400 - Validation error (missing ticketId/qrCode, ticket already used, expired, or invalid status)
 * @returns {Object} 403 - Access denied (ticket belongs to different company)
 * @returns {Object} 404 - Ticket not found
 */
router.post('/validate', requireCompanyContext, async (req: Request, res: Response) => {
  try {
    const { ticketId, qrCode, location, notes } = req.body || {};

    let resolvedTicketId = ticketId;
    if (!resolvedTicketId && qrCode) {
      try {
        const decoded = Buffer.from(qrCode, 'base64').toString('utf-8');
        const payload = JSON.parse(decoded);
        resolvedTicketId = payload.t || payload.ticketId;
      } catch (error) {
        return res.status(400).json({
          message: 'Invalid QR code',
          error: 'Unable to decode QR payload',
        });
      }
    }

    if (!resolvedTicketId) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'ticketId or qrCode is required',
      });
    }

    const cachedTicket = await getTicketCache(resolvedTicketId);
    if (cachedTicket?.status === TicketStatus.COMPLETED) {
      return res.status(400).json({
        message: 'Ticket already completed',
        error: 'This ticket has already been used',
      });
    }

    const alreadyUsed = await isTicketAlreadyUsed(resolvedTicketId);
    if (alreadyUsed) {
      return res.status(400).json({
        message: 'Ticket already used',
        error: 'This ticket has already been validated',
      });
    }

    const ticket = await Ticket.findOne({ ticketId: resolvedTicketId });

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    const companyId = res.locals.companyId?.toString();
    if (ticket.companyId !== companyId) {
      return res.status(403).json({
        message: 'Access denied',
        error: 'This ticket does not belong to your company',
      });
    }

    if (ticket.status === TicketStatus.COMPLETED) {
      return res.status(400).json({
        message: 'Ticket already completed',
        error: 'This ticket has already been used',
      });
    }

    if ([TicketStatus.CANCELLED, TicketStatus.INVALID].includes(ticket.status)) {
      return res.status(400).json({
        message: 'Ticket is not valid',
        error: `Ticket status is urrently ${ticket.status}`,
      });
    }

    if (ticket.expiresAt && ticket.expiresAt.getTime() < Date.now()) {
      ticket.status = TicketStatus.EXPIRED;
      await ticket.save();
      return res.status(400).json({
        message: 'Ticket expired',
        error: 'This ticket can no longer be used',
      });
    }

    const validatorEmail = res.locals.companyAdminEmail || req.body.validatorEmail;
    await validateTicketAndMarkUsed({
      ticket,
      validatorEmail,
      validatorRole: res.locals.isAdmin ? 'cf_admin' : 'merchant_admin',
      location,
      notes,
    });

    return res.status(200).json({
      message: 'Ticket validated successfully',
      ticket,
    });
  } catch (error) {
    console.error('Error validating ticket:', (error as any)?.message);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
