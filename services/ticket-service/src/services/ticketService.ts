import crypto from 'crypto';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { Ticket, ITicket, TicketStatus } from '../models/Ticket';
import { publishTicketGenerated, publishTicketValidated } from '../utils/kafka';
import { setTicketCache, markTicketAsUsed } from '../utils/cache';

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:4002';
const DEFAULT_EXPIRY_HOURS = Number(process.env.TICKET_EXPIRY_HOURS || 72);

export interface TicketPayload {
  orderId: string;
  orderNumber?: string;
  companyId: string;
  companyName: string;
  companyEmail?: string;
  companyApiKey?: string;
  customerInfo: {
    customerName: string;
    customerEmail: string;
    customerPhone?: string;
  };
  items?: Array<{
    productId: string;
    productName: string;
    quantity: number;
    price: number;
  }>;
  totalAmount?: number;
  currency?: string;
  expiresAt?: Date;
}

/**
 * Builds a compact JSON payload for QR code generation.
 * 
 * This function creates a minimal, URL-safe payload structure that will be encoded
 * into a QR code. The payload uses abbreviated keys (t, o, c) to minimize QR code
 * size while maintaining all essential ticket information. This is crucial for our
 * project because:
 * - Smaller QR codes are easier to scan and more reliable
 * - Contains ticket ID, order ID, company ID, and timestamp for validation
 * - Enables offline validation capabilities when scanned by validators
 * 
 * @param ticketId - Unique identifier for the ticket
 * @param orderId - Associated order identifier
 * @param companyId - Company/merchant identifier
 * @returns JSON string containing the QR payload data
 */
const buildQrPayload = (ticketId: string, orderId: string, companyId: string) => {
  return JSON.stringify({
    t: ticketId,
    o: orderId,
    c: companyId,
    issuedAt: new Date().toISOString(),
  });
};

/**
 * Generates a unique, human-readable ticket identifier.
 * 
 * This function creates a distinctive ticket ID that combines multiple entropy sources
 * to ensure uniqueness and prevent collisions. The format includes a timestamp for
 * chronological ordering and random components for security. This is essential for our
 * project because:
 * - Provides unique identifiers that prevent ticket duplication
 * - Human-readable format (TKT- prefix) makes tickets easy to identify in logs and UI
 * - Timestamp component enables quick chronological sorting and debugging
 * - Multiple random sources ensure high entropy and prevent predictable ticket IDs
 * - Supports our fulfillment tracking system by providing traceable ticket references
 * 
 * @returns A unique ticket ID in the format: TKT-{timestamp}-{random}{uuidFragment}
 */
const generateTicketId = () => {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  const uuidFragment = uuidv4().split('-')[0].toUpperCase();
  return `TKT-${Date.now()}-${random}${uuidFragment}`;
};

/**
 * Creates a new fulfillment ticket for an order or returns an existing one.
 * 
 * This is the core function for ticket generation in our fulfillment system. It handles
 * the complete ticket lifecycle from creation to notification. This function is critical
 * for our project because:
 * - Prevents duplicate tickets for the same order (idempotent operation)
 * - Generates QR codes that enable quick validation at fulfillment points
 * - Sets up expiration dates to ensure tickets are used within a valid timeframe
 * - Caches ticket data for fast validation lookups (improves performance)
 * - Links tickets to orders in the order service (maintains data consistency)
 * - Publishes ticket generation events via Kafka for real-time notifications
 * - Supports our multi-tenant architecture with company-specific ticket management
 * 
 * The function ensures that customers receive their fulfillment tickets with all
 * necessary metadata, and other services are notified of ticket creation for downstream
 * processing (e.g., email notifications, order status updates).
 * 
 * @param payload - Complete ticket information including order, company, and customer details
 * @returns The created or existing ticket document
 */
export const createTicket = async (payload: TicketPayload) => {
  let ticket = await Ticket.findOne({ orderId: payload.orderId });
  if (ticket) {
    return ticket;
  }

  const ticketId = generateTicketId();
  const qrPayload = buildQrPayload(ticketId, payload.orderId, payload.companyId);
  const qrCode = Buffer.from(qrPayload).toString('base64');

  const expiresAt =
    payload.expiresAt ||
    new Date(Date.now() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000);

  ticket = await Ticket.create({
    ticketId,
    orderId: payload.orderId,
    orderNumber: payload.orderNumber,
    companyId: payload.companyId,
    companyName: payload.companyName,
    companyApiKey: payload.companyApiKey,
    issuedTo: payload.customerInfo,
    qrPayload,
    qrCode,
    expiresAt,
    status: TicketStatus.PENDING,
    metadata: {
      items: payload.items,
      totalAmount: payload.totalAmount,
      currency: payload.currency,
    },
  });

  await setTicketCache(ticket.ticketId, {
    status: ticket.status,
    orderId: ticket.orderId,
    companyId: ticket.companyId,
    expiresAt: ticket.expiresAt,
  });

  await attachTicketToOrder(ticket.orderId, ticket.ticketId);

  await publishTicketGenerated({
    ticketId: ticket.ticketId,
    orderId: ticket.orderId,
    orderNumber: ticket.orderNumber,
    companyId: ticket.companyId,
    companyName: ticket.companyName,
    companyEmail: payload.companyEmail,
    customerInfo: payload.customerInfo,
    items: payload.items,
    totalAmount: payload.totalAmount,
    currency: payload.currency,
    expiresAt: ticket.expiresAt,
    status: ticket.status,
    qrCode,
  });

  return ticket;
};

/**
 * Attaches a ticket ID to the corresponding order in the order service.
 * 
 * This function maintains data consistency across microservices by linking tickets
 * to their parent orders. It performs an internal service-to-service communication
 * to update the order record. This is important for our project because:
 * - Keeps order and ticket data synchronized across services
 * - Enables order service to track which orders have associated fulfillment tickets
 * - Supports order lookup by ticket ID and vice versa
 * - Uses internal service authentication for secure inter-service communication
 * - Gracefully handles failures (logs error but doesn't break ticket creation flow)
 * 
 * The function uses a timeout and internal service token to ensure reliable but
 * non-blocking communication with the order service, maintaining system resilience.
 * 
 * @param orderId - The order identifier to attach the ticket to
 * @param ticketId - The ticket identifier to link to the order
 */
export const attachTicketToOrder = async (orderId: string, ticketId: string) => {
  try {
    await axios.patch(
      `${ORDER_SERVICE_URL}/orders/${orderId}/ticket`,
      { ticketId },
      {
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service': 'ticket-service',
          Authorization: process.env.INTERNAL_SERVICE_TOKEN
            ? `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`
            : undefined,
        },
      }
    );
  } catch (error) {
    console.error('Failed to attach ticket to order:', (error as any)?.message);
  }
};

export interface ValidateTicketInput {
  ticket: ITicket;
  validatorEmail?: string;
  validatorId?: string;
  validatorRole?: 'cf_admin' | 'merchant_admin' | 'store_admin';
  location?: string;
  notes?: string;
}

/**
 * Validates a ticket and marks it as completed/used.
 * 
 * This function handles the fulfillment validation process when a ticket is scanned
 * and verified at a fulfillment location. It updates the ticket status, records
 * validation history, and triggers downstream notifications. This is crucial for
 * our project because:
 * - Prevents ticket reuse by marking tickets as COMPLETED after validation
 * - Maintains an audit trail of who validated the ticket, when, and where
 * - Updates cache to reflect ticket status changes (prevents double validation)
 * - Publishes validation events via Kafka for real-time order fulfillment tracking
 * - Supports multiple validator roles (admin, merchant, store) for access control
 * - Enables fulfillment analytics and reporting through validation history
 * 
 * The function ensures that once a ticket is validated, it cannot be used again,
 * and all relevant systems are notified of the fulfillment completion. This supports
 * our end-to-end order fulfillment tracking system.
 * 
 * @param input - Validation details including ticket, validator info, location, and notes
 * @returns The updated ticket document with validation information
 */
export const validateTicketAndMarkUsed = async (input: ValidateTicketInput) => {
  const { ticket } = input;
  ticket.status = TicketStatus.COMPLETED;
  ticket.validatedAt = new Date();
  ticket.lastValidatorEmail = input.validatorEmail;
  ticket.lastValidatorId = input.validatorId;

  ticket.validationHistory.push({
    status: TicketStatus.COMPLETED,
    validatedAt: ticket.validatedAt,
    validatorEmail: input.validatorEmail,
    validatorId: input.validatorId,
    validatorRole: input.validatorRole,
    location: input.location,
    notes: input.notes,
  });

  await ticket.save();
  await markTicketAsUsed(ticket.ticketId);
  await setTicketCache(ticket.ticketId, {
    status: ticket.status,
    orderId: ticket.orderId,
    companyId: ticket.companyId,
    expiresAt: ticket.expiresAt,
  });

  await publishTicketValidated({
    ticketId: ticket.ticketId,
    orderId: ticket.orderId,
    companyId: ticket.companyId,
    companyName: ticket.companyName,
    status: ticket.status,
    validatedAt: ticket.validatedAt,
    validatorEmail: input.validatorEmail,
    validatorRole: input.validatorRole,
  });

  return ticket;
};

