import { Kafka } from 'kafkajs';

// Initialize Kafka client
const kafka = new Kafka({
  clientId: 'order-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  connectionTimeout: 10000, // 10 seconds connection timeout
  requestTimeout: 30000, // 30 seconds request timeout
  retry: {
    initialRetryTime: 300,
    retries: 8,
    maxRetryTime: 30000,
  },
});

const producer = kafka.producer();

// Connect producer on service startup
let isConnected = false;
let isConnecting = false;

// Helper function to ensure producer is connected
const ensureConnected = async (forceReconnect: boolean = false): Promise<boolean> => {
  // If already connecting, wait a bit and check again
  if (isConnecting && !forceReconnect) {
    await new Promise(resolve => setTimeout(resolve, 100));
    return isConnected;
  }

  // If already connected and not forcing reconnect, return true
  // Note: We trust the flag here, but if a send fails due to disconnection,
  // sendWithRetry will catch it and force a reconnect
  if (isConnected && !forceReconnect) {
    return true;
  }

  // Attempt to connect (or reconnect if forceReconnect is true)
  isConnecting = true;
  isConnected = false; // Reset flag before attempting connection
  
  try {
    // If forcing reconnect, the producer might be in a disconnected state
    // KafkaJS should handle this, but we'll try to connect anyway
    await producer.connect();
    isConnected = true;
    isConnecting = false;
    console.log('✅ Kafka producer connected');
    return true;
  } catch (error: any) {
    isConnected = false;
    isConnecting = false;
    
    // Check if error is because already connected (this is actually fine)
    if (error.message?.includes('already connected')) {
      isConnected = true;
      return true;
    }
    
    // Handle DNS resolution errors (ENOTFOUND) and connection errors
    const errorMessage = error?.message || '';
    const errorCode = error?.code || '';
    const isDnsError = errorCode === 'ENOTFOUND' || errorMessage.includes('getaddrinfo ENOTFOUND');
    const isConnectionError = errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT' || 
                               errorMessage.includes('Connection timeout') || 
                               errorMessage.includes('Connection error');
    
    if (isDnsError || isConnectionError) {
      console.error(`❌ Failed to connect Kafka producer: ${errorCode || 'Connection error'} - ${errorMessage}`);
      console.log('⚠️  This usually means Kafka is not ready yet. Will retry...');
    } else {
      console.error('❌ Failed to connect Kafka producer:', errorMessage || error);
    }
    
    return false;
  }
};

export const connectKafkaProducer = async () => {
  return await ensureConnected();
};

// Disconnect producer on service shutdown
export const disconnectKafkaProducer = async () => {
  try {
    if (isConnected) {
      await producer.disconnect();
      isConnected = false;
      console.log('✅ Kafka producer disconnected');
    }
  } catch (error) {
    console.error('❌ Failed to disconnect Kafka producer:', error);
    isConnected = false;
  }
};

// Helper function to send message with reconnection logic
const sendWithRetry = async (
  topic: string,
  messages: Array<{ key: string; value: string }>,
  eventName: string
): Promise<void> => {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      // Ensure we're connected before sending
      const connected = await ensureConnected();
      if (!connected) {
        throw new Error('Failed to connect to Kafka producer');
      }

      // Attempt to send the message
      await producer.send({
        topic,
        messages,
      });

      return; // Success, exit retry loop
    } catch (error: any) {
      retryCount++;
      
      // Check if error is due to disconnection or connection issues
      // KafkaJS throws errors with specific messages when producer is disconnected
      const errorMessage = error?.message?.toLowerCase() || '';
      const errorCode = error?.code || '';
      const isDnsError = errorCode === 'ENOTFOUND' || errorMessage.includes('getaddrinfo enotfound');
      const isConnectionError = errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT' || 
                                errorMessage.includes('connection timeout') ||
                                errorMessage.includes('connection error');
      const isDisconnectionError = 
        errorMessage.includes('disconnected') ||
        errorMessage.includes('connection closed') ||
        errorMessage.includes('the producer is disconnected') ||
        errorMessage.includes('not connected') ||
        isDnsError ||
        isConnectionError ||
        error?.type === 'KafkaJSError' ||
        error?.name === 'KafkaJSError';

      if (isDisconnectionError && retryCount < maxRetries) {
        // Reset connection state and try to reconnect
        console.warn(`⚠️  Kafka producer disconnected. Attempting to reconnect (attempt ${retryCount}/${maxRetries})...`);
        isConnected = false;
        isConnecting = false; // Reset connecting flag as well
        
        // Wait before retrying (exponential backoff)
        const waitTime = Math.min(1000 * Math.pow(2, retryCount - 1), 5000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Force reconnect before next attempt
        const reconnected = await ensureConnected(true);
        if (reconnected) {
          continue; // Try sending again
        } else {
          // If reconnect failed, wait a bit more and try again
          console.warn(`⚠️  Reconnection failed, will retry...`);
          continue;
        }
      }

      // If we've exhausted retries or it's not a disconnection error, throw
      throw error;
    }
  }
};

// Publish order_created event to Kafka
export const publishOrderCreated = async (orderData: {
  orderId: string;
  orderNumber: string;
  companyId: string;
  companyName: string;
  customerInfo: {
    customerName: string;
    customerEmail: string;
    customerPhone?: string;
  };
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    price: number;
  }>;
  totalAmount: number;
  status: string;
  createdAt: Date;
}) => {
  try {
    await sendWithRetry(
      'order_created',
      [
        {
          key: orderData.orderId,
          value: JSON.stringify({
            ...orderData,
            timestamp: new Date().toISOString(),
            eventType: 'order_created',
          }),
        },
      ],
      'order_created'
    );

    console.log(`✅ Published order_created event for order ${orderData.orderNumber}`);
  } catch (error: any) {
    console.error('❌ Failed to publish order_created event:', error.message || error);
    // Don't throw error - order is already created, event publishing failure shouldn't fail the request
  }
};

// Publish order_status_updated event to Kafka
// This event is consumed by Ticket Service to generate tickets when status is "packed"
// and by Notification Service to send status update emails
export const publishOrderStatusUpdated = async (orderData: {
  orderId: string;
  orderNumber: string;
  companyId: string;
  companyName: string;
  companyEmail?: string;
  customerInfo: {
    customerName: string;
    customerEmail: string;
    customerPhone?: string;
    customerAddress?: string;
  };
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    price: number;
  }>;
  totalAmount: number;
  currency: string;
  oldStatus: string;
  newStatus: string;
  ticketId?: string;
  updatedAt: Date;
}) => {
  try {
    await sendWithRetry(
      'order_status_updated',
      [
        {
          key: orderData.orderId,
          value: JSON.stringify({
            ...orderData,
            timestamp: new Date().toISOString(),
            eventType: 'order_status_updated',
          }),
        },
      ],
      'order_status_updated'
    );

    console.log(`✅ Published order_status_updated event for order ${orderData.orderNumber} (${orderData.oldStatus} → ${orderData.newStatus})`);
  } catch (error: any) {
    console.error('❌ Failed to publish order_status_updated event:', error.message || error);
  }
};

// Publish order_deleted event to Kafka (hard delete - Lead CF Admin only)
export const publishOrderDeleted = async (orderData: {
  orderId: string;
  orderNumber: string;
  companyId: string;
  deletedAt: Date;
}) => {
  try {
    await sendWithRetry(
      'order_deleted',
      [
        {
          key: orderData.orderId,
          value: JSON.stringify({
            ...orderData,
            timestamp: new Date().toISOString(),
            eventType: 'order_deleted',
          }),
        },
      ],
      'order_deleted'
    );

    console.log(`✅ Published order_deleted event for order ${orderData.orderNumber}`);
  } catch (error: any) {
    console.error('❌ Failed to publish order_deleted event:', error.message || error);
  }
};

// Publish order_soft_deleted event to Kafka (soft delete - merchant/admin marks as deleted)
// This is different from order_deleted which is hard delete (Lead CF Admin only)
export const publishOrderSoftDeleted = async (orderData: {
  orderId: string;
  orderNumber: string;
  companyId: string;
  companyName: string;
  oldStatus: string;
  deletedAt: Date;
  deletedBy?: {
    type: 'merchant' | 'company_admin' | 'cf_admin';
    email?: string;
    id?: string;
  };
}) => {
  try {
    await sendWithRetry(
      'order_soft_deleted',
      [
        {
          key: orderData.orderId,
          value: JSON.stringify({
            orderId: orderData.orderId,
            orderNumber: orderData.orderNumber,
            companyId: orderData.companyId,
            companyName: orderData.companyName,
            status: 'deleted',
            oldStatus: orderData.oldStatus,
            timestamp: new Date().toISOString(),
            deletedAt: orderData.deletedAt,
            deletedBy: orderData.deletedBy,
            eventType: 'order_soft_deleted',
          }),
        },
      ],
      'order_soft_deleted'
    );

    console.log(`✅ Published order_soft_deleted event for order ${orderData.orderNumber}`);
  } catch (error: any) {
    console.error('❌ Failed to publish order_soft_deleted event:', error.message || error);
  }
};

// Publish ticket_attached_to_order event to Kafka
// This event is published when Ticket Service attaches a ticketId to an order
// Notification Service consumes this to send ticket/QR code emails to customers
// If isReplacement is true, Notification Service will send a different email indicating ticket was updated
export const publishTicketAttached = async (orderData: {
  orderId: string;
  orderNumber: string;
  companyId: string;
  companyName: string;
  ticketId: string;
  oldTicketId?: string;
  isReplacement?: boolean;
  replacedBy?: {
    adminEmail: string;
    adminId: string;
    adminName?: string;
  };
  customerInfo: {
    customerName: string;
    customerEmail: string;
    customerPhone?: string;
  };
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    price: number;
  }>;
  totalAmount: number;
  currency: string;
  status: string;
  attachedAt: Date;
}) => {
  try {
    await sendWithRetry(
      'ticket_attached_to_order',
      [
        {
          key: orderData.orderId,
          value: JSON.stringify({
            ...orderData,
            timestamp: new Date().toISOString(),
            eventType: 'ticket_attached_to_order',
          }),
        },
      ],
      'ticket_attached_to_order'
    );

    if (orderData.isReplacement) {
      console.log(`✅ Published ticket_attached_to_order event (REPLACEMENT) for order ${orderData.orderNumber}: ${orderData.oldTicketId} → ${orderData.ticketId}`);
    } else {
      console.log(`✅ Published ticket_attached_to_order event for order ${orderData.orderNumber} with ticket ${orderData.ticketId}`);
    }
  } catch (error: any) {
    console.error('❌ Failed to publish ticket_attached_to_order event:', error.message || error);
  }
};


// Summary of Kafka Events Published by Order Service:
// 1. order_created - Published when a new order is created
// 2. order_status_updated - Published when order status changes (consumed by Ticket Service when status="packed" and Notification Service for status emails)
// 3. order_soft_deleted - Published when an order is soft-deleted by merchant/admin (status changed to "deleted", order still visible)
// 4. order_deleted - Published when an order is hard-deleted by Lead CF Admin (moved to deleted_orders collection)
// 5. ticket_attached_to_order - Published when Ticket Service attaches a ticketId to an order (consumed by Notification Service to send QR code emails)
