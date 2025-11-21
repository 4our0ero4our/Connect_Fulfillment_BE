import dotenv from 'dotenv';
import { Kafka, EachMessagePayload, logLevel } from 'kafkajs';
import {
  handleOrderStatusUpdated,
  handleTicketGenerated,
  handleTicketValidated,
  handleAdminPasswordChanged,
  handleAdminAdded,
  handleOrderDeleted,
  handleCompanyVerified,
  handleCompanyApiKeyStatusChanged,
  handleCompanyStatusChanged,
  handleCompanyAdminRemoved,
  handleOrderSoftDeleted,
} from '../services/notificationService';

dotenv.config();

const kafka = new Kafka({
  clientId: 'notification-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  logLevel: logLevel.ERROR,
});

const consumer = kafka.consumer({
  groupId: process.env.KAFKA_CONSUMER_GROUP || 'notification-service-consumer',
});

let consumerConnected = false;

const topicHandlers: Record<string, (payload: any) => Promise<void>> = {
  order_status_updated: handleOrderStatusUpdated,
  ticket_generated: handleTicketGenerated,
  ticket_attached_to_order: handleTicketGenerated,
  ticket_validated: handleTicketValidated,
  admin_password_changed: handleAdminPasswordChanged,
  admin_added_to_company: handleAdminAdded,
  cf_admin_added: handleAdminAdded,
  order_deleted: handleOrderDeleted,
  company_verified: handleCompanyVerified,
  company_api_key_status_changed: handleCompanyApiKeyStatusChanged,
  company_status_changed: handleCompanyStatusChanged,
  company_admin_removed: handleCompanyAdminRemoved,
  order_soft_deleted: handleOrderSoftDeleted,
};

export const startNotificationConsumers = async () => {
  if (consumerConnected) return;

  await consumer.connect();
  consumerConnected = true;
  console.log('✅ Notification service connected to Kafka');

  const topics = Object.keys(topicHandlers);
  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  await consumer.run({
    eachMessage: async ({ topic, message }: EachMessagePayload) => {
      try {
        const handler = topicHandlers[topic];
        if (!handler) return;

        const payload = message.value?.toString();
        if (!payload) return;

        const data = JSON.parse(payload);
        await handler(data);
      } catch (error) {
        console.error(`Failed to process ${topic} message:`, (error as any)?.message);
      }
    },
  });
};

export const disconnectKafka = async () => {
  if (!consumerConnected) return;
  await consumer.disconnect();
  consumerConnected = false;
};

