import { Router } from 'express';
import { Request, Response } from 'express';
import { Order, OrderStatus, IOrder } from '../models/Order';
import { verifyMerchant, verifyCFAdmin, verifyAdminOrMerchant, verifyOrderAccess } from '../middleware/orderAccessControl';
import { verifyCompanyApiKey } from '../middleware/verifyCompanyApiKey';
import { verifyCompanyAdmin } from '../middleware/verifyCompanyAdmin';
import { publishOrderCreated, publishOrderStatusUpdated, publishOrderDeleted, publishTicketAttached } from '../utils/kafkaProducer';

const router = Router();

// ✅ Working perfectly
// Health check endpoint
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Order Service is running', service: 'order-service' });
});

// ✅ Working perfectly
// Create a new order (Merchant only)
// POST /order
// Security: Company ID is extracted from API key validation (gateway middleware), NOT from request body
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

// ✅ Working perfectly
// Get all orders (CF Admin: all orders, Company Admin/Merchant: their own company's orders)
// GET /orders
// Authentication: CF Admin JWT token OR Company Admin JWT token OR Company API key
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

// ✅ Working perfectly
// Get order by ID (CF Admin: any order, Company Admin/Merchant: their own company's orders only)
// GET /orders/:orderId
// Authentication: CF Admin JWT token OR Company Admin JWT token OR Company API key
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

// ✅ Working perfectly
// Update order status (CF Admin, Company Admin, or Merchant)
// PATCH /orders/:orderId/status
// Authentication: CF Admin JWT token OR Company Admin JWT token OR Company API key
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

// Delete order (CF Admin, Company Admin, or Merchant - marks as deleted, doesn't actually get deleted from the database here. Only the status is updated to "deleted" and it's only a lead CF Admin that can actually delete the order from the database and it's another route for that.)
// DELETE /orders/:orderId
// Authentication: CF Admin JWT token OR Company Admin JWT token OR Company API key
// Note: Orders are marked with status "deleted" instead of being removed from database
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

    // Publish order_deleted event to Kafka
    await publishOrderDeleted({
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      companyId: order.companyId,
      deletedAt: new Date(),
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

// Attach ticket to order (Internal endpoint for Ticket Service)
// PATCH /orders/:orderId/ticket
// This endpoint is called by Ticket Service after generating a ticket for an order with status="packed"
// Ticket Service will call this endpoint directly (bypassing API Gateway) or via internal service token
router.patch('/orders/:orderId/ticket', async (req: Request, res: Response) => {
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

    // Check if ticket is already attached
    if (order.ticketId && order.ticketId === ticketId) {
      return res.status(400).json({
        message: 'Validation error',
        error: 'This ticket is already attached to this order'
      });
    }

    // Validate that order status is "packed" (tickets should only be generated for packed orders)
    if (order.status !== OrderStatus.PACKED) {
      return res.status(400).json({
        message: 'Validation error',
        error: `Tickets can only be attached to orders with status "packed". Current status: ${order.status}`
      });
    }

    const oldTicketId = order.ticketId;

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
        oldTicketId: oldTicketId || null,
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

// Get all orders for a specific company (Admin only)
// GET /orders/company/:companyId
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

// Get orders for a customer by email (Public route - no auth required, just email verification)
// POST /orders/customer
// Body: customerEmail (required), companyId (optional)
// If companyId is "all" or not provided, return all orders for the customer from all merchants
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

// import { DeletedOrder } from '../models/DeletedOrder';
// import { verifyLeadCFAdmin } from '../middleware/orderAccessControl';
//
// Hard delete order (Lead CF Admin only) - moves document to deleted_orders collection and removes from orders
// Disabled for now (route commented out) but kept for testing/documentation purposes
//
// DELETE /orders/:orderId/hard-delete
// router.delete('/orders/:orderId/hard-delete', verifyLeadCFAdmin, async (req: Request, res: Response) => {
// 	try {
// 		const orderId = req.params.orderId;
// 		const order = await Order.findById(orderId);
// 		if (!order) {
// 			return res.status(404).json({
// 				message: 'Order not found',
// 				error: 'The order you are trying to delete does not exist'
// 			});
// 		}
//
// 		// Move order to deleted_orders collection with metadata
// 		await DeletedOrder.create({
// 			orderId: order._id.toString(),
// 			orderNumber: order.orderNumber,
// 			companyId: order.companyId,
// 			companyApiKey: (order as any).companyApiKey,
// 			companyName: order.companyName,
// 			items: order.items,
// 			customerInfo: order.customerInfo,
// 			ticketId: order.ticketId,
// 			statusBeforeDelete: order.status,
// 			totalAmount: order.totalAmount,
// 			currency: order.currency,
// 			notes: order.notes,
// 			createdAtOriginal: order.createdAt,
// 			deletedAt: new Date(),
// 			deletedBy: { adminEmail: res.locals.adminEmail, adminId: res.locals.adminId }
// 		});
//
// 		// Remove from orders collection
// 		await Order.findByIdAndDelete(orderId);
//
// 		return res.status(200).json({
// 			message: 'Order hard-deleted successfully',
// 			orderId: orderId,
// 			orderNumber: order.orderNumber
// 		});
// 	} catch (error: any) {
// 		console.error('Error hard-deleting order:', error);
// 		return res.status(500).json({
// 			message: 'Internal server error',
// 			error: error?.message || 'An unknown error occurred'
// 		});
// 	}
// });

export default router;
