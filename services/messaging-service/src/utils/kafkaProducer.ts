import { Kafka } from 'kafkajs';

const kafka = new Kafka({
  clientId: 'messaging-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  connectionTimeout: 10000,
  requestTimeout: 30000,
  retry: {
    initialRetryTime: 300,
    retries: 8,
    maxRetryTime: 30000,
  },
});

const producer = kafka.producer();
let isConnected = false;
let isConnecting = false;

const ensureConnected = async (forceReconnect: boolean = false): Promise<boolean> => {
  if (isConnecting && !forceReconnect) {
    await new Promise(resolve => setTimeout(resolve, 100));
    return isConnected;
  }

  if (isConnected && !forceReconnect) {
    return true;
  }

  isConnecting = true;
  isConnected = false;

  try {
    await producer.connect();
    isConnected = true;
    isConnecting = false;
    console.log('✅ Kafka producer connected (messaging-service)');
    return true;
  } catch (error: any) {
    isConnected = false;
    isConnecting = false;

    if (error.message?.includes('already connected')) {
      isConnected = true;
      return true;
    }

    console.error('❌ Failed to connect Kafka producer:', error?.message || error);
    return false;
  }
};

const sendWithRetry = async (
  topic: string,
  messages: Array<{ key: string; value: string }>,
  eventType: string,
  retries = 3
): Promise<void> => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const connected = await ensureConnected(attempt > 0);
      if (!connected) {
        throw new Error('Kafka producer not connected');
      }

      await producer.send({
        topic,
        messages,
      });

      return;
    } catch (error: any) {
      if (attempt === retries - 1) {
        console.error(`❌ Failed to publish ${eventType} after ${retries} attempts:`, error?.message || error);
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
};

/**
 * Publishes a message_created event to Kafka.
 * 
 * @param {Object} messageData - Message information
 */
export const publishMessageCreated = async (messageData: {
  messageId: string;
  ticketId: string;
  ticketNumber: string;
  companyId: string;
  companyName: string;
  senderType: 'merchant' | 'cf_admin';
  senderEmail: string;
  senderName: string;
  content: string;
  createdAt: Date;
}) => {
  try {
    await sendWithRetry(
      'message_created',
      [
        {
          key: messageData.ticketId,
          value: JSON.stringify({
            ...messageData,
            timestamp: new Date().toISOString(),
            eventType: 'message_created',
          }),
        },
      ],
      'message_created'
    );

    console.log(`✅ Published message_created event for ticket ${messageData.ticketNumber}`);
  } catch (error: any) {
    console.error('❌ Failed to publish message_created event:', error.message || error);
  }
};

/**
 * Publishes a ticket_created event to Kafka.
 * 
 * @param {Object} ticketData - Ticket information
 */
export const publishTicketCreated = async (ticketData: {
  ticketId: string;
  ticketNumber: string;
  companyId: string;
  companyName: string;
  createdBy: {
    type: 'merchant' | 'cf_admin';
    userEmail: string;
    userName: string;
  };
  customName?: string;
  category?: string;
  priority?: string;
  createdAt: Date;
}) => {
  try {
    await sendWithRetry(
      'support_ticket_created',
      [
        {
          key: ticketData.ticketId,
          value: JSON.stringify({
            ...ticketData,
            timestamp: new Date().toISOString(),
            eventType: 'support_ticket_created',
          }),
        },
      ],
      'support_ticket_created'
    );

    console.log(`✅ Published support_ticket_created event for ticket ${ticketData.ticketNumber}`);
  } catch (error: any) {
    console.error('❌ Failed to publish support_ticket_created event:', error.message || error);
  }
};

/**
 * Publishes a ticket_status_updated event to Kafka.
 * 
 * @param {Object} ticketData - Ticket status update information
 */
export const publishTicketStatusUpdated = async (ticketData: {
  ticketId: string;
  ticketNumber: string;
  companyId: string;
  companyName: string;
  oldStatus: string;
  newStatus: string;
  updatedBy: {
    type: 'merchant' | 'cf_admin';
    userEmail: string;
    userName: string;
  };
  assignedTo?: {
    cfAdminEmail: string;
    cfAdminName: string;
  };
  updatedAt: Date;
}) => {
  try {
    await sendWithRetry(
      'support_ticket_status_updated',
      [
        {
          key: ticketData.ticketId,
          value: JSON.stringify({
            ...ticketData,
            timestamp: new Date().toISOString(),
            eventType: 'support_ticket_status_updated',
          }),
        },
      ],
      'support_ticket_status_updated'
    );

    console.log(`✅ Published support_ticket_status_updated event for ticket ${ticketData.ticketNumber}`);
  } catch (error: any) {
    console.error('❌ Failed to publish support_ticket_status_updated event:', error.message || error);
  }
};

export const connectKafkaProducer = async () => {
  return await ensureConnected();
};

export const disconnectKafkaProducer = async () => {
  try {
    if (isConnected) {
      await producer.disconnect();
      isConnected = false;
      console.log('✅ Kafka producer disconnected (messaging-service)');
    }
  } catch (error: any) {
    console.error('❌ Error disconnecting Kafka producer:', error?.message || error);
  }
};

