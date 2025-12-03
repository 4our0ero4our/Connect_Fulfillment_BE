import { Router } from 'express';
import { Request, Response } from 'express';
import { Order, OrderStatus, IOrder } from '../models/Order';
import { verifyMerchant, verifyCFAdmin, verifyAdminOrMerchant, verifyOrderAccess, verifyInternalService } from '../middleware/orderAccessControl';
import { verifyCompanyApiKey } from '../middleware/verifyCompanyApiKey';
import { verifyCompanyAdmin } from '../middleware/verifyCompanyAdmin';
import { publishOrderCreated, publishOrderStatusUpdated, publishOrderDeleted, publishOrderSoftDeleted, publishTicketAttached } from '../utils/kafkaProducer';
import { createAuditLog, extractUserInfo } from '../utils/auditLogger';

const router = Router();

/**
 * Health check endpoint for the Order Service.
 * Returns a simple status message to confirm the service is running.
 * 
 * @route GET /
 * @returns {Object} Service status message
 */
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Order Service is running', service: 'order-service' });
});

/**
 * Create a new order for a merchant company.
 * 
 * Creates an order with items and customer information. The company ID is
 * automatically extracted from the API key validation (via gateway middleware),
 * so it cannot be spoofed in the request body. Publishes an order_created
 * event to Kafka for downstream processing.
 * 
 * @route POST /
 * @access Private (requires Company API key in header)
 * 
 * @param {Array} req.body.items - Array of order items (productId, productName, quantity, price)
 * @param {Object} req.body.customerInfo - Customer details (customerName, customerEmail, customerPhone, customerAddress)
 * @param {string} [req.body.ticketId] - Optional ticket ID to attach
 * @param {string} [req.body.notes] - Optional order notes
 * @param {string} [req.body.currency] - Currency code (default: 'NGN')
 * 
 * @returns {Object} 201 - Order created successfully with order details
 * @returns {Object} 400 - Validation error (missing fields, invalid data)
 */
router.post('/', verifyCompanyApiKey, verifyMerchant, async (req: Request, res: Response) => {
  try {
    // Reject any attempt to send companyId in body
    if (req.body.companyId || req.body.companyApiKey) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Company ID and API key must be provided via header, not in request body'
      });
    }

    const { items, customerInfo, ticketId, notes, currency } = req.body;
    // Company info is securely extracted from API key validation in gateway middleware
    const companyId = res.locals.companyId;
    const companyApiKey = res.locals.companyApiKey;
    const companyName = res.locals.companyName;
    const companyEmail = res.locals.companyEmail;
    const company = res.locals.company;

    // Check if company service is active
    if (company && company.isServiceActive === false) {
      return res.status(503).json({
        message: 'Service unavailable',
        error: 'This merchant is currently not accepting orders. Please try again later.',
        serviceStatus: 'inactive',
        companyName: companyName
      });
    }

    // Validation checks
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Order must have at least one item'
      });
    }

    if (!customerInfo || !customerInfo.customerName || !customerInfo.customerEmail) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Customer information (name and email) is required',
        errors: {
          customerName: !customerInfo?.customerName ? 'Customer name is required' : null,
          customerEmail: !customerInfo?.customerEmail ? 'Customer email is required' : null,
        }
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerInfo.customerEmail)) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Invalid customer email format'
      });
    }

    // Validate items
    for (const item of items) {
      if (!item.productId || !item.productName || !item.quantity || !item.price) {
        return res.status(400).json({
          message: 'Validation error',
          error: 'Each item must have productId, productName, quantity, and price'
        });
      }
      if (item.quantity < 1) {
        return res.status(400).json({
          message: 'Validation error',
          error: 'Item quantity must be at least 1'
        });
      }
      if (item.price < 0) {
        return res.status(400).json({
          message: 'Validation error',
          error: 'Item price cannot be negative'
        });
      }
    }

    // Calculate total amount
    const totalAmount = items.reduce((sum: number, item: any) => {
      const subtotal = item.quantity * item.price;
      item.subtotal = subtotal;
      return sum + subtotal;
    }, 0);

    // Create order
    const order = await Order.create({
      // orderNumber: `ORD-${companyId}-${Date.now()}`,
      companyId,
      companyApiKey,
      companyName,
      items,
      customerInfo: {
        customerName: customerInfo.customerName,
        customerEmail: customerInfo.customerEmail.toLowerCase(),
        customerPhone: customerInfo.customerPhone,
        customerAddress: customerInfo.customerAddress,
      },
      ticketId: ticketId || undefined,
      status: OrderStatus.PENDING,
      totalAmount,
      currency: currency || 'NGN',
      notes: notes || undefined,
    });

    // Publish order_created event to Kafka
    await publishOrderCreated({
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      companyId: order.companyId,
      companyName: order.companyName,
      customerInfo: {
        customerName: order.customerInfo.customerName,
        customerEmail: order.customerInfo.customerEmail,
        customerPhone: order.customerInfo.customerPhone,
      },
      items: order.items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        price: item.price,
      })),
      totalAmount: order.totalAmount,
      status: order.status,
      createdAt: order.createdAt,
    });

    // Create audit log
    let userInfo = extractUserInfo(res.locals);

    // Try to extract more specific admin info from JWT if available
    // This fixes the issue where manually created orders don't show the admin email
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET!);

        if (decoded.companyAdminEmail || decoded.email) {
          userInfo = {
            performedBy: decoded.companyAdminEmail || decoded.email,
            performedByRole: 'merchant_admin',
            performedById: decoded.companyAdminId || decoded.id || decoded._id,
            performedByName: decoded.companyAdminName || decoded.name,
          };
        }
      } catch (error) {
        // If token verification fails, just stick with the default userInfo (API key based)
        // We don't want to fail the order creation just because of a token issue if the API key was valid
        console.warn('Failed to extract admin info from token for audit log:', error);
      }
    }

    await createAuditLog({
      action: 'order_created',
      ...userInfo,
      targetCompany: companyId,
      targetCompanyName: companyName,
      targetOrder: order._id.toString(),
      targetOrderNumber: order.orderNumber,
      details: {
        customerEmail: order.customerInfo.customerEmail,
        customerName: order.customerInfo.customerName,
        totalAmount: order.totalAmount,
        currency: order.currency,
        itemCount: order.items.length,
        status: order.status,
      },
      service: 'order-service',
    }, req);

    // Return order without sensitive data
    const orderResponse = order.toObject();
    res.status(201).json({
      message: 'Order created successfully',
      order: {
        id: orderResponse._id,
        orderNumber: orderResponse.orderNumber,
        companyId: orderResponse.companyId,
        companyName: orderResponse.companyName,
        items: orderResponse.items,
        customerInfo: orderResponse.customerInfo,
        ticketId: orderResponse.ticketId,
        status: orderResponse.status,
        totalAmount: orderResponse.totalAmount,
        currency: orderResponse.currency,
        notes: orderResponse.notes,
        createdAt: orderResponse.createdAt,
        updatedAt: orderResponse.updatedAt,
      }
    });
  } catch (error: any) {
    console.error('Error creating order:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Validation error',
        error: error.message
      });
    }

    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get all orders with pagination and filtering.
 * 
 * Returns orders based on the requester's role:
 * - CF Admins: Can see all orders from all companies
 * - Company Admins/Merchants: Can only see their own company's orders
 * 
 * Supports filtering by status and date range, with pagination.
 * 
 * @route GET /orders
 * @access Private (requires CF Admin token OR Company Admin token OR Company API key)
 * 
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=10] - Number of orders per page
 * @param {string} [req.query.status] - Filter by order status (pending, processing, packed, completed, cancelled, deleted)
 * @param {string} [req.query.startDate] - Filter orders created after this date (ISO format)
 * @param {string} [req.query.endDate] - Filter orders created before this date (ISO format)
 * 
 * @returns {Object} 200 - Paginated list of orders with pagination metadata
 */
router.get('/orders', verifyAdminOrMerchant, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const status = req.query.status as string;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const skip = (page - 1) * limit;

    // Build query
    const query: any = {};

    // Company Admin/Merchant can only see their own company's orders
    if (res.locals.isMerchant || res.locals.isCompanyAdmin) {
      query.companyId = res.locals.companyId;
    }
    // CF Admin can see all orders (no companyId filter)

    // Filter by status
    if (status && Object.values(OrderStatus).includes(status as OrderStatus)) {
      query.status = status;
    }

    // Filter by date range
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate);
      }
    }

    // Get total count for pagination
    const totalOrders = await Order.countDocuments(query);

    // Get orders with pagination
    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.status(200).json({
      message: 'Orders retrieved successfully',
      orders: orders.map(order => ({
        id: order._id,
        orderNumber: order.orderNumber,
        companyId: order.companyId,
        companyName: order.companyName,
        items: order.items,
        customerInfo: order.customerInfo,
        ticketId: order.ticketId,
        status: order.status,
        totalAmount: order.totalAmount,
        currency: order.currency,
        notes: order.notes,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      })),
      pagination: {
        page,
        limit,
        total: totalOrders,
        totalPages: Math.ceil(totalOrders / limit),
        hasNextPage: page < Math.ceil(totalOrders / limit),
        hasPrevPage: page > 1,
      }
    });
  } catch (error: any) {
    console.error('Error retrieving orders:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get a specific order by ID.
 * 
 * Returns detailed information about a single order. Access control:
 * - CF Admins: Can access any order
 * - Company Admins/Merchants: Can only access their own company's orders
 * 
 * @route GET /orders/:orderId
 * @access Private (requires CF Admin token OR Company Admin token OR Company API key)
 * 
 * @param {string} req.params.orderId - MongoDB ObjectId of the order
 * 
 * @returns {Object} 200 - Order details
 * @returns {Object} 403 - Access denied (order belongs to different company)
 * @returns {Object} 404 - Order not found
 */
router.get('/orders/:orderId', verifyAdminOrMerchant, verifyOrderAccess, async (req: Request, res: Response) => {
  try {
    const order = res.locals.order;

    res.status(200).json({
      message: 'Order retrieved successfully',
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        companyId: order.companyId,
        companyName: order.companyName,
        items: order.items,
        customerInfo: order.customerInfo,
        ticketId: order.ticketId,
        status: order.status,
        totalAmount: order.totalAmount,
        currency: order.currency,
        notes: order.notes,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      }
    });
  } catch (error: any) {
    console.error('Error retrieving order:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Update the status of an order.
 * 
 * Changes the order status through the lifecycle: pending → processing → packed → completed.
 * When status changes to "packed", it triggers ticket generation via Kafka event.
 * Cannot set status to "deleted" via this endpoint (use DELETE endpoint for that).
 * 
 * @route PATCH /orders/:orderId/status
 * @access Private (requires CF Admin token OR Company Admin token OR Company API key)
 * 
 * @param {string} req.params.orderId - MongoDB ObjectId of the order
 * @param {string} req.body.status - New status (pending, processing, packed, completed, cancelled)
 * 
 * @returns {Object} 200 - Order status updated successfully
 * @returns {Object} 400 - Validation error (invalid status, status unchanged, cannot set to deleted)
 * @returns {Object} 403 - Access denied
 * @returns {Object} 404 - Order not found
 */
router.patch('/orders/:orderId/status', verifyAdminOrMerchant, verifyOrderAccess, async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const order = res.locals.order as IOrder;

    // Validation
    if (!status) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Status is required'
      });
    }

    if (!Object.values(OrderStatus).includes(status as OrderStatus)) {
      return res.status(400).json({
        message: 'Validation error',
        error: `Invalid status. Must be one of: ${Object.values(OrderStatus).join(', ')}`
      });
    }

    // Prevent setting status to "deleted" via this endpoint
    // Use DELETE /orders/:orderId endpoint to mark orders as deleted
    if (status === OrderStatus.DELETED) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Cannot set order status to "deleted" via this endpoint. Use DELETE /orders/:orderId to mark orders as deleted.'
      });
    }

    // Check if status is actually changing
    if (order.status === status) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Order status is already set to this value'
      });
    }

    const oldStatus = order.status;

    // Update order status
    order.status = status as OrderStatus;
    await order.save();

    // Publish order_status_updated event to Kafka
    // Ticket Service consumes this to generate tickets when status="packed"
    // Notification Service consumes this to send status update emails
    await publishOrderStatusUpdated({
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      companyId: order.companyId,
      companyName: order.companyName,
      customerInfo: {
        customerName: order.customerInfo.customerName,
        customerEmail: order.customerInfo.customerEmail,
        customerPhone: order.customerInfo.customerPhone,
        customerAddress: order.customerInfo.customerAddress,
      },
      items: order.items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        price: item.price,
      })),
      totalAmount: order.totalAmount,
      currency: order.currency,
      oldStatus,
      newStatus: status,
      ticketId: order.ticketId,
      updatedAt: order.updatedAt,
    });

    // Create audit log
    let userInfo = extractUserInfo(res.locals);

    // Try to extract more specific admin info from JWT if available
    if (req.headers.authorization) {
      try {
        const token = req.headers.authorization.replace('Bearer ', '');
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET!);

        if (decoded.companyAdminEmail || decoded.email) {
          userInfo = {
            performedBy: decoded.companyAdminEmail || decoded.email,
            performedByRole: 'merchant_admin',
            performedById: decoded.companyAdminId || decoded.id || decoded._id,
            performedByName: decoded.companyAdminName || decoded.name,
          };
        }
      } catch (error) {
        console.warn('Failed to extract admin info from token for audit log:', error);
      }
    }

    await createAuditLog({
      action: 'order_status_updated',
      ...userInfo,
      targetCompany: order.companyId,
      targetCompanyName: order.companyName,
      targetOrder: order._id.toString(),
      targetOrderNumber: order.orderNumber,
      details: {
        oldValue: { status: oldStatus },
        newValue: { status: status },
      },
      service: 'order-service',
    }, req);

    res.status(200).json({
      message: 'Order status updated successfully',
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        oldStatus,
        updatedAt: order.updatedAt,
      }
    });
  } catch (error: any) {
    console.error('Error updating order status:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Soft delete an order (mark as deleted).
 * 
 * Marks an order with status "deleted" instead of removing it from the database.
 * The order remains visible but with deleted status. This is different from
 * hard delete (DELETE /orders/:orderId/hard-delete) which permanently removes
 * the order. Publishes order_soft_deleted event to Kafka.
 * 
 * @route DELETE /orders/:orderId
 * @access Private (requires CF Admin token OR Company Admin token OR Company API key)
 * 
 * @param {string} req.params.orderId - MongoDB ObjectId of the order
 * 
 * @returns {Object} 200 - Order soft deleted successfully
 * @returns {Object} 400 - Order already deleted
 * @returns {Object} 403 - Access denied
 * @returns {Object} 404 - Order not found
 */
router.delete('/orders/:orderId', verifyAdminOrMerchant, verifyOrderAccess, async (req: Request, res: Response) => {
  try {
    const orderId = req.params.orderId;
    const order = res.locals.order as IOrder;

    // Check if order exists
    if (!order) {
      return res.status(404).json({
        message: 'Order not found',
        error: 'The order you are looking for does not exist'
      });
    }

    // Check if already deleted
    if (order.status === OrderStatus.DELETED) {
      return res.status(400).json({
        message: 'Order already deleted',
        error: 'This order has already been marked as deleted'
      });
    }

    const oldStatus = order.status;

    // Mark order as deleted (soft delete)
    order.status = OrderStatus.DELETED;
    await order.save();

    // Determine who deleted the order
    const deletedBy = res.locals.isAdmin
      ? { type: 'cf_admin' as const, email: res.locals.adminEmail, id: res.locals.adminId }
      : res.locals.isCompanyAdmin
        ? { type: 'company_admin' as const, email: res.locals.companyAdminEmail, id: res.locals.companyAdminId }
        : { type: 'merchant' as const };

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'order_soft_deleted',
      ...userInfo,
      targetCompany: order.companyId,
      targetCompanyName: order.companyName,
      targetOrder: order._id.toString(),
      targetOrderNumber: order.orderNumber,
      details: {
        oldStatus: oldStatus,
        newStatus: 'deleted',
        customerEmail: order.customerInfo.customerEmail,
        deletedByType: deletedBy.type,
      },
      service: 'order-service',
    }, req);

    // Publish order_soft_deleted event to Kafka (soft delete - order still visible with "deleted" status)
    await publishOrderSoftDeleted({
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      companyId: order.companyId,
      companyName: order.companyName,
      oldStatus,
      deletedAt: new Date(),
      deletedBy,
    });

    res.status(200).json({
      message: 'Order deleted successfully',
      deletedOrder: {
        id: order._id.toString(),
        orderNumber: order.orderNumber,
        oldStatus,
        status: order.status,
        deletedAt: order.updatedAt,
      }
    });
  } catch (error: any) {
    console.error('Error deleting order:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Attach a ticket to an order (Internal service only).
 * 
 * This endpoint is used by the Ticket Service to automatically attach a ticket
 * when an order status changes to "packed". Only internal services with the
 * correct INTERNAL_SERVICE_TOKEN can use this endpoint. For CF Admin ticket
 * replacement, use PATCH /orders/:orderId/ticket/replace instead.
 * 
 * @route PATCH /orders/:orderId/ticket
 * @access Internal (requires INTERNAL_SERVICE_TOKEN)
 * 
 * @param {string} req.params.orderId - MongoDB ObjectId of the order
 * @param {string} req.body.ticketId - Ticket ID to attach to the order
 * 
 * @returns {Object} 200 - Ticket attached successfully
 * @returns {Object} 400 - Validation error (ticket already attached, order not in packed status)
 * @returns {Object} 404 - Order not found
 */
router.patch('/orders/:orderId/ticket', verifyInternalService, async (req: Request, res: Response) => {
  try {
    const orderId = req.params.orderId;
    const { ticketId } = req.body;

    // Validation
    if (!ticketId || typeof ticketId !== 'string') {
      return res.status(400).json({
        message: 'Validation error',
        error: 'ticketId is required and must be a string'
      });
    }

    // Find order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        message: 'Order not found',
        error: 'The order you are trying to update does not exist'
      });
    }

    // Check if ticket is already attached with the same ID
    if (order.ticketId && order.ticketId === ticketId) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'This ticket is already attached to this order'
      });
    }

    // Initial ticket attachment - validate that order status is "packed"
    if (order.status !== OrderStatus.PACKED) {
      return res.status(400).json({
        message: 'Validation error',
        error: `Tickets can only be attached to orders with status "packed". Current status: ${order.status}`
      });
    }

    // Prevent replacing existing tickets via this endpoint (use /replace endpoint for that)
    if (order.ticketId) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'This order already has a ticket attached. Use the /replace endpoint to replace it.'
      });
    }

    // Update order with ticketId
    order.ticketId = ticketId;
    await order.save();

    // Publish ticket_attached_to_order event to Kafka
    // Notification Service consumes this to send QR code emails to customers
    await publishTicketAttached({
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      companyId: order.companyId,
      companyName: order.companyName,
      ticketId: ticketId,
      isReplacement: false,
      customerInfo: {
        customerName: order.customerInfo.customerName,
        customerEmail: order.customerInfo.customerEmail,
        customerPhone: order.customerInfo.customerPhone,
      },
      items: order.items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        price: item.price,
      })),
      totalAmount: order.totalAmount,
      currency: order.currency,
      status: order.status,
      attachedAt: order.updatedAt,
    });

    res.status(200).json({
      message: 'Ticket attached to order successfully',
      order: {
        id: order._id.toString(),
        orderNumber: order.orderNumber,
        ticketId: order.ticketId,
        status: order.status,
        updatedAt: order.updatedAt,
      }
    });
  } catch (error: any) {
    console.error('Error attaching ticket to order:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Replace a ticket on an order (CF Admin only).
 * 
 * Allows CF Admins to replace an existing ticket in rare edge cases (e.g., ticket
 * corruption, system errors). Merchants cannot replace tickets. Publishes
 * ticket_attached_to_order event with isReplacement=true to notify the customer.
 * 
 * @route PATCH /orders/:orderId/ticket/replace
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.params.orderId - MongoDB ObjectId of the order
 * @param {string} req.body.ticketId - New ticket ID to replace the existing one
 * 
 * @returns {Object} 200 - Ticket replaced successfully, customer will be notified
 * @returns {Object} 400 - Validation error (no existing ticket, same ticket ID)
 * @returns {Object} 404 - Order not found
 */
router.patch('/orders/:orderId/ticket/replace', verifyCFAdmin, async (req: Request, res: Response) => {
  try {
    const orderId = req.params.orderId;
    const { ticketId } = req.body;

    // Validation
    if (!ticketId || typeof ticketId !== 'string') {
      return res.status(400).json({
        message: 'Validation error',
        error: 'ticketId is required and must be a string'
      });
    }

    // Find order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        message: 'Order not found',
        error: 'The order you are trying to update does not exist'
      });
    }

    // Check if ticket is already attached with the same ID
    if (order.ticketId && order.ticketId === ticketId) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'This ticket is already attached to this order'
      });
    }

    const oldTicketId = order.ticketId;

    if (!oldTicketId) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'This order does not have a ticket to replace. Use the /ticket endpoint for initial attachment.'
      });
    }

    // Update order with new ticketId
    order.ticketId = ticketId;
    await order.save();

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'ticket_replaced',
      ...userInfo,
      targetCompany: order.companyId,
      targetCompanyName: order.companyName,
      targetOrder: order._id.toString(),
      targetOrderNumber: order.orderNumber,
      targetTicket: ticketId,
      details: {
        oldTicketId: oldTicketId,
        newTicketId: ticketId,
        reason: 'CF Admin replacement',
      },
      service: 'order-service',
    }, req);

    // Publish ticket_attached_to_order event to Kafka with isReplacement=true
    // Notification Service consumes this to send updated ticket emails to customers
    await publishTicketAttached({
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      companyId: order.companyId,
      companyName: order.companyName,
      ticketId: ticketId,
      oldTicketId: oldTicketId,
      isReplacement: true,
      replacedBy: {
        adminEmail: res.locals.adminEmail,
        adminId: res.locals.adminId,
        adminName: res.locals.adminName,
      },
      customerInfo: {
        customerName: order.customerInfo.customerName,
        customerEmail: order.customerInfo.customerEmail,
        customerPhone: order.customerInfo.customerPhone,
      },
      items: order.items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        price: item.price,
      })),
      totalAmount: order.totalAmount,
      currency: order.currency,
      status: order.status,
      attachedAt: order.updatedAt,
    });

    res.status(200).json({
      message: 'Ticket replaced successfully. Customer will be notified of the update.',
      order: {
        id: order._id.toString(),
        orderNumber: order.orderNumber,
        ticketId: order.ticketId,
        oldTicketId: oldTicketId,
        isReplacement: true,
        status: order.status,
        updatedAt: order.updatedAt,
      }
    });
  } catch (error: any) {
    console.error('Error replacing ticket on order:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get all orders for a specific company (CF Admin only).
 * 
 * Returns paginated list of orders for a given company. Only CF Admins can
 * access this endpoint to view orders across different companies.
 * 
 * @route GET /orders/company/:companyId
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.params.companyId - MongoDB ObjectId of the company
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=10] - Number of orders per page
 * @param {string} [req.query.status] - Filter by order status
 * 
 * @returns {Object} 200 - Paginated list of company orders
 * @returns {Object} 404 - Company not found
 */
router.get('/orders/company/:companyId', verifyCFAdmin, async (req: Request, res: Response) => {
  try {
    const companyId = req.params.companyId;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const status = req.query.status as string;
    const skip = (page - 1) * limit;

    // Build query
    const query: any = { companyId };

    // Filter by status if provided
    if (status && Object.values(OrderStatus).includes(status as OrderStatus)) {
      query.status = status;
    }

    // Get total count for pagination
    const totalOrders = await Order.countDocuments(query);

    // Get orders with pagination
    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.status(200).json({
      message: 'Company orders retrieved successfully',
      companyId,
      orders: orders.map(order => ({
        id: order._id,
        orderNumber: order.orderNumber,
        companyId: order.companyId,
        companyName: order.companyName,
        items: order.items,
        customerInfo: order.customerInfo,
        ticketId: order.ticketId,
        status: order.status,
        totalAmount: order.totalAmount,
        currency: order.currency,
        notes: order.notes,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      })),
      pagination: {
        page,
        limit,
        total: totalOrders,
        totalPages: Math.ceil(totalOrders / limit),
        hasNextPage: page < Math.ceil(totalOrders / limit),
        hasPrevPage: page > 1,
      }
    });
  } catch (error: any) {
    console.error('Error retrieving company orders:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get orders for a customer by email (Public route).
 * 
 * Allows customers to retrieve their order history by providing their email.
 * No authentication required, but email format is validated. Can filter by
 * specific company or return all orders from all merchants.
 * 
 * @route POST /orders/customer
 * @access Public (no authentication required)
 * 
 * @param {string} req.body.customerEmail - Customer email address (required)
 * @param {string} [req.body.companyId] - Company ID to filter by, or "all" for all companies
 * @param {number} [req.query.page=1] - Page number for pagination
 * @param {number} [req.query.limit=50] - Number of orders per page (default: 50)
 * 
 * @returns {Object} 200 - Paginated list of customer orders
 * @returns {Object} 400 - Validation error (missing email, invalid email format)
 */
router.post('/orders/customer', async (req: Request, res: Response) => {
  try {
    const { customerEmail, companyId } = req.body;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50; // Default 50 for customer view
    const skip = (page - 1) * limit;

    // Validation
    if (!customerEmail) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'customerEmail is required in request body'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const normalizedEmail = customerEmail.toLowerCase();
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Invalid email format'
      });
    }

    // Build query
    const query: any = {
      'customerInfo.customerEmail': normalizedEmail
    };

    // Filter by company if provided and not "all"
    if (companyId && companyId !== 'all') {
      query.companyId = companyId;
    }

    // Get total count for pagination
    const totalOrders = await Order.countDocuments(query);

    // Get orders with pagination, sorted by most recent first
    // Note: Deleted orders are included (status will show as "deleted")
    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.status(200).json({
      message: 'Customer orders retrieved successfully',
      customerEmail: normalizedEmail,
      companyId: companyId && companyId !== 'all' ? companyId : 'all',
      orders: orders.map(order => ({
        id: order._id,
        orderNumber: order.orderNumber,
        companyId: order.companyId,
        companyName: order.companyName,
        items: order.items.map(item => ({
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          price: item.price,
          subtotal: item.subtotal,
        })),
        customerInfo: order.customerInfo,
        ticketId: order.ticketId,
        status: order.status, // Will show "deleted" for deleted orders
        totalAmount: order.totalAmount,
        currency: order.currency,
        notes: order.notes,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      })),
      pagination: {
        page,
        limit,
        total: totalOrders,
        totalPages: Math.ceil(totalOrders / limit),
        hasNextPage: page < Math.ceil(totalOrders / limit),
        hasPrevPage: page > 1,
      }
    });
  } catch (error: any) {
    console.error('Error retrieving customer orders:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get current month revenue metrics (CF Admin only).
 * 
 * Returns the total revenue from all orders created in the current month.
 * This endpoint is restricted to Connect Fulfillment platform admins only.
 * 
 * @route GET /orders/metrics/current-month
 * @access Private (requires CF Admin JWT token)
 * 
 * @returns {Object} 200 - Current month revenue metrics
 * @returns {Object} 403 - Access denied (not a CF Admin)
 */
router.get('/orders/metrics/current-month', verifyCFAdmin, async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Aggregate revenue for current month
    const result = await Order.aggregate([
      {
        $match: {
          createdAt: {
            $gte: startOfMonth,
            $lte: endOfMonth
          }
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$totalAmount' },
          totalOrders: { $sum: 1 },
          averageOrderValue: { $avg: '$totalAmount' }
        }
      }
    ]);

    const metrics = result[0] || {
      totalRevenue: 0,
      totalOrders: 0,
      averageOrderValue: 0
    };

    res.status(200).json({
      message: 'Current month revenue metrics retrieved successfully',
      metrics: {
        totalRevenue: metrics.totalRevenue,
        totalOrders: metrics.totalOrders,
        averageOrderValue: Math.round(metrics.averageOrderValue * 100) / 100,
        currency: 'NGN',
        period: {
          type: 'current-month',
          month: now.getMonth() + 1,
          year: now.getFullYear(),
          startDate: startOfMonth.toISOString(),
          endDate: endOfMonth.toISOString()
        },
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('Error retrieving current month revenue metrics:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get revenue metrics for a specific month (CF Admin only).
 * 
 * Returns the total revenue from all orders created in the specified month.
 * Month should be provided as year and month (e.g., /orders/metrics/2025/01 for January 2025).
 * This endpoint is restricted to Connect Fulfillment platform admins only.
 * 
 * @route GET /orders/metrics/:year/:month
 * @access Private (requires CF Admin JWT token)
 * 
 * @param {string} req.params.year - Year (e.g., "2025")
 * @param {string} req.params.month - Month (1-12, e.g., "01" or "1")
 * 
 * @returns {Object} 200 - Month revenue metrics
 * @returns {Object} 400 - Validation error (invalid year or month)
 * @returns {Object} 403 - Access denied (not a CF Admin)
 */
router.get('/orders/metrics/:year/:month', verifyCFAdmin, async (req: Request, res: Response) => {
  try {
    const year = parseInt(req.params.year);
    const month = parseInt(req.params.month);

    // Validation
    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Invalid year. Year must be between 2000 and 2100'
      });
    }

    if (isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'Invalid month. Month must be between 1 and 12'
      });
    }

    // Calculate start and end of the specified month
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    // Aggregate revenue for the specified month
    const result = await Order.aggregate([
      {
        $match: {
          createdAt: {
            $gte: startOfMonth,
            $lte: endOfMonth
          }
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$totalAmount' },
          totalOrders: { $sum: 1 },
          averageOrderValue: { $avg: '$totalAmount' }
        }
      }
    ]);

    const metrics = result[0] || {
      totalRevenue: 0,
      totalOrders: 0,
      averageOrderValue: 0
    };

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    res.status(200).json({
      message: 'Month revenue metrics retrieved successfully',
      metrics: {
        totalRevenue: metrics.totalRevenue,
        totalOrders: metrics.totalOrders,
        averageOrderValue: Math.round(metrics.averageOrderValue * 100) / 100,
        currency: 'NGN',
        period: {
          type: 'specific-month',
          month: month,
          monthName: monthNames[month - 1],
          year: year,
          startDate: startOfMonth.toISOString(),
          endDate: endOfMonth.toISOString()
        },
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('Error retrieving month revenue metrics:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

/**
 * Get total revenue metrics (CF Admin only).
 * 
 * Returns the total revenue from all orders that have been created.
 * This endpoint is restricted to Connect Fulfillment platform admins only.
 * 
 * @route GET /orders/metrics
 * @access Private (requires CF Admin JWT token)
 * 
 * @returns {Object} 200 - Total revenue metrics
 * @returns {Object} 403 - Access denied (not a CF Admin)
 */
router.get('/orders/metrics', verifyCFAdmin, async (req: Request, res: Response) => {
  try {
    // Aggregate total revenue from all orders
    const result = await Order.aggregate([
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$totalAmount' },
          totalOrders: { $sum: 1 },
          averageOrderValue: { $avg: '$totalAmount' }
        }
      }
    ]);

    const metrics = result[0] || {
      totalRevenue: 0,
      totalOrders: 0,
      averageOrderValue: 0
    };

    res.status(200).json({
      message: 'Revenue metrics retrieved successfully',
      metrics: {
        totalRevenue: metrics.totalRevenue,
        totalOrders: metrics.totalOrders,
        averageOrderValue: Math.round(metrics.averageOrderValue * 100) / 100,
        currency: 'NGN', // Default currency, you might want to aggregate by currency
        period: 'all-time',
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('Error retrieving revenue metrics:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

// ✅ Working perfectly
import { DeletedOrder } from '../models/DeletedOrder';
import { verifyLeadCFAdmin } from '../middleware/orderAccessControl';

/**
 * Hard delete an order (Lead CF Admin only).
 * 
 * Permanently removes an order from the orders collection and moves it to
 * the deleted_orders collection for analytics purposes. This is irreversible.
 * Only Lead CF Admins can perform this action. Publishes order_deleted event
 * to Kafka.
 * 
 * @route DELETE /orders/:orderId/hard-delete
 * @access Private (requires Lead CF Admin JWT token)
 * 
 * @param {string} req.params.orderId - MongoDB ObjectId of the order
 * 
 * @returns {Object} 200 - Order hard deleted successfully
 * @returns {Object} 403 - Access denied (not a Lead CF Admin)
 * @returns {Object} 404 - Order not found
 */
router.delete('/orders/:orderId/hard-delete', verifyLeadCFAdmin, async (req: Request, res: Response) => {
  try {
    const orderId = req.params.orderId;
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        message: 'Order not found',
        error: 'The order you are trying to delete does not exist'
      });
    }

    // Move order to deleted_orders collection with metadata
    await DeletedOrder.create({
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      companyId: order.companyId,
      companyApiKey: (order as any).companyApiKey,
      companyName: order.companyName,
      items: order.items,
      customerInfo: order.customerInfo,
      ticketId: order.ticketId,
      statusBeforeDelete: order.status,
      totalAmount: order.totalAmount,
      currency: order.currency,
      notes: order.notes,
      createdAtOriginal: order.createdAt,
      deletedAt: new Date(),
      deletedBy: { adminEmail: res.locals.adminEmail, adminId: res.locals.adminId }
    });

    // Remove from orders collection
    await Order.findByIdAndDelete(orderId);

    // Create audit log
    const userInfo = extractUserInfo(res.locals);
    await createAuditLog({
      action: 'order_hard_deleted',
      ...userInfo,
      targetCompany: order.companyId,
      targetCompanyName: order.companyName,
      targetOrder: order._id.toString(),
      targetOrderNumber: order.orderNumber,
      details: {
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        statusBeforeDelete: order.status,
        customerEmail: order.customerInfo.customerEmail,
        totalAmount: order.totalAmount,
        currency: order.currency,
        movedToDeletedOrders: true,
      },
      service: 'order-service',
    }, req);

    return res.status(200).json({
      message: 'Order hard-deleted successfully',
      orderId: orderId,
      orderNumber: order.orderNumber
    });
  } catch (error: any) {
    console.error('Error hard-deleting order:', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: error?.message || 'An unknown error occurred'
    });
  }
});

export default router;
