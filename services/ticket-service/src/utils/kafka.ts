import dotenv from 'dotenv';
import { Kafka, EachMessagePayload, logLevel } from 'kafkajs';

dotenv.config();

const kafka = new Kafka({
  clientId: 'ticket-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  logLevel: logLevel.ERROR,
  retry: {
    retries: 8,
    maxRetryTime: 30000,
  },
});

const producer = kafka.producer();
const consumer = kafka.consumer({
  groupId: process.env.KAFKA_CONSUMER_GROUP || 'ticket-service-consumer',
});

let producerConnected = false;
let consumerConnected = false;
let consumerRunning = false;

const ensureProducer = async () => {
  if (producerConnected) return true;
  try {
    await producer.connect();
    producerConnected = true;
    console.log('✅ Kafka producer connected (ticket-service)');
    return true;
  } catch (error) {
    console.error('Failed to connect Kafka producer:', (error as any)?.message);
    producerConnected = false;
    return false;
  }
};

export const publishTicketGenerated = async (payload: Record<string, unknown>) => {
  try {
    const connected = await ensureProducer();
    if (!connected) return;

    await producer.send({
      topic: 'ticket_generated',
      messages: [
        {
          key: payload.orderId as string,
          value: JSON.stringify({
            ...payload,
            eventType: 'ticket_generated',
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    });

    console.log(`✅ Published ticket_generated event for order ${payload.orderId}`);
  } catch (error) {
    console.error('Failed to publish ticket_generated event:', (error as any)?.message);
  }
};

export const publishTicketValidated = async (payload: Record<string, unknown>) => {
  try {
    const connected = await ensureProducer();
    if (!connected) return;

    await producer.send({
      topic: 'ticket_validated',
      messages: [
        {
          key: payload.ticketId as string,
          value: JSON.stringify({
            ...payload,
            eventType: 'ticket_validated',
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    });

    console.log(`✅ Published ticket_validated event for ticket ${payload.ticketId}`);
  } catch (error) {
    console.error('Failed to publish ticket_validated event:', (error as any)?.message);
  }
};

export type OrderStatusUpdatedHandler = (payload: any) => Promise<void>;

export const startOrderStatusConsumer = async (handler: OrderStatusUpdatedHandler) => {
  if (consumerRunning) return;

  try {
    if (!consumerConnected) {
      await consumer.connect();
      consumerConnected = true;
      console.log('✅ Kafka consumer connected (ticket-service)');
    }

    await consumer.subscribe({ topic: 'order_status_updated', fromBeginning: false });

    await consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        try {
          const message = payload.message.value?.toString();
          if (!message) return;
          const data = JSON.parse(message);
          if (!data?.newStatus) return;

          await handler(data);
        } catch (error) {
          console.error('Failed to process Kafka message:', (error as any)?.message);
        }
      },
    });

    consumerRunning = true;
  } catch (error) {
    consumerRunning = false;
    console.error('Failed to start Kafka consumer:', (error as any)?.message);
  }
};

export const disconnectKafka = async () => {
  try {
    if (consumerConnected) {
      await consumer.disconnect();
      consumerConnected = false;
      consumerRunning = false;
      console.log('Kafka consumer disconnected (ticket-service)');
    }
  } catch (error) {
    console.error('Failed to disconnect Kafka consumer:', (error as any)?.message);
  }

  try {
    if (producerConnected) {
      await producer.disconnect();
      producerConnected = false;
      console.log('Kafka producer disconnected (ticket-service)');
    }
  } catch (error) {
    console.error('Failed to disconnect Kafka producer:', (error as any)?.message);
  }
};

