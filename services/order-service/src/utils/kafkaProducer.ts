import { Kafka } from 'kafkajs';

// Initialize Kafka client
const kafka = new Kafka({
  clientId: 'order-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
});

const producer = kafka.producer();

// Connect producer on service startup
let isConnected = false;

export const connectKafkaProducer = async () => {
  try {
    if (!isConnected) {
      await producer.connect();
      isConnected = true;
      console.log('Kafka producer connected');
    }
  } catch (error) {
    console.error('Failed to connect Kafka producer:', error);
    isConnected = false;
  }
};

// Disconnect producer on service shutdown
export const disconnectKafkaProducer = async () => {
  try {
    if (isConnected) {
      await producer.disconnect();
      isConnected = false;
      console.log('Kafka producer disconnected');
    }
  } catch (error) {
    console.error('Failed to disconnect Kafka producer:', error);
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
    if (!isConnected) {
      await connectKafkaProducer();
    }

    await producer.send({
      topic: 'order_created',
      messages: [
        {
          key: orderData.orderId,
          value: JSON.stringify({
            ...orderData,
            timestamp: new Date().toISOString(),
            eventType: 'order_created',
          }),
        },
      ],
    });

    console.log(`✅ Published order_created event for order ${orderData.orderNumber}`);
  } catch (error) {
    console.error('❌ Failed to publish order_created event:', error);
    // Don't throw error - order is already created, event publishing failure shouldn't fail the request
  }
};

// Publish order_status_updated event to Kafka
export const publishOrderStatusUpdated = async (orderData: {
  orderId: string;
  orderNumber: string;
  companyId: string;
  oldStatus: string;
  newStatus: string;
  updatedAt: Date;
}) => {
  try {
    if (!isConnected) {
      await connectKafkaProducer();
    }

    await producer.send({
      topic: 'order_status_updated',
      messages: [
        {
          key: orderData.orderId,
          value: JSON.stringify({
            ...orderData,
            timestamp: new Date().toISOString(),
            eventType: 'order_status_updated',
          }),
        },
      ],
    });

    console.log(`✅ Published order_status_updated event for order ${orderData.orderNumber}`);
  } catch (error) {
    console.error('❌ Failed to publish order_status_updated event:', error);
  }
};

// Publish order_deleted event to Kafka
export const publishOrderDeleted = async (orderData: {
  orderId: string;
  orderNumber: string;
  companyId: string;
  deletedAt: Date;
}) => {
  try {
    if (!isConnected) {
      await connectKafkaProducer();
    }

    await producer.send({
      topic: 'order_deleted',
      messages: [
        {
          key: orderData.orderId,
          value: JSON.stringify({
            ...orderData,
            timestamp: new Date().toISOString(),
            eventType: 'order_deleted',
          }),
        },
      ],
    });

    console.log(`✅ Published order_deleted event for order ${orderData.orderNumber}`);
  } catch (error) {
    console.error('❌ Failed to publish order_deleted event:', error);
  }
};


// Summary of the Kafka producer:
// The Kafka producer is used to publish events to Kafka.
// The events are published to the Kafka topics in the order_created, order_status_updated, and order_deleted topics.
