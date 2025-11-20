
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

router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Ticket Service is running', service: 'ticket-service' });
});

// This endpoint is used to create a ticket
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

// This endpoint is used to get a ticket by its ID
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

// This endpoint is used to get a ticket by its order ID
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

// This endpoint is used to update a ticket
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

// This endpoint is used to validate a ticket
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
