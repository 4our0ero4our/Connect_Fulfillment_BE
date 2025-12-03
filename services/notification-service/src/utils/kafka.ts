import dotenv from 'dotenv';
import { Kafka, EachMessagePayload, logLevel } from 'kafkajs';
import {
  handleOrderStatusUpdated,
  handleTicketGenerated,
  handleTicketValidated,
  handleAdminPasswordChanged,
  handleAdminAdded,
  handleMerchantAdminRegistered,
  handleOrderDeleted,
  handleCompanyVerified,
  handleCompanyApiKeyStatusChanged,
  handleCompanyApiKeyRotated,
  handleCompanyStatusChanged,
  handleCompanyAdminRemoved,
  handleOrderSoftDeleted,
  handleOrderCreated,
  handleSupportTicketCreated,
  handleMessageCreated,
  handleSupportTicketStatusUpdated,
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
  order_created: handleOrderCreated,
  order_status_updated: handleOrderStatusUpdated,
  ticket_generated: handleTicketGenerated,
  ticket_attached_to_order: handleTicketGenerated,
  ticket_validated: handleTicketValidated,
  admin_password_changed: handleAdminPasswordChanged,
  admin_added_to_company: handleAdminAdded,
  cf_admin_added: handleAdminAdded,
  merchant_admin_registered: handleMerchantAdminRegistered,
  order_deleted: handleOrderDeleted,
  company_verified: handleCompanyVerified,
  company_api_key_status_changed: handleCompanyApiKeyStatusChanged,
  company_api_key_rotated: handleCompanyApiKeyRotated,
  company_status_changed: handleCompanyStatusChanged,
  company_admin_removed: handleCompanyAdminRemoved,
  order_soft_deleted: handleOrderSoftDeleted,
  support_ticket_created: handleSupportTicketCreated,
  message_created: handleMessageCreated,
  support_ticket_status_updated: handleSupportTicketStatusUpdated,
};

export const startNotificationConsumers = async () => {
  if (consumerConnected) {
    console.log('⚠️ Kafka consumer already connected, skipping reconnection');
    return;
  }

  let retries = 0;
  const maxRetries = 10;
  
  while (retries < maxRetries) {
    try {
      console.log(`🔄 Attempting to connect to Kafka (attempt ${retries + 1}/${maxRetries})...`);
      await consumer.connect();
      consumerConnected = true;
      console.log('✅ Notification service connected to Kafka');

      const topics = Object.keys(topicHandlers);
      console.log(`📋 Subscribing to ${topics.length} topics:`, topics.join(', '));
      
      for (const topic of topics) {
        try {
          await consumer.subscribe({ topic, fromBeginning: false });
          console.log(`✅ Subscribed to topic: ${topic}`);
        } catch (error) {
          console.error(`❌ Failed to subscribe to topic ${topic}:`, (error as any)?.message);
        }
      }

      await consumer.run({
        eachMessage: async ({ topic, message }: EachMessagePayload) => {
          try {
            console.log(`📨 Received Kafka message on topic: ${topic}`);
            const handler = topicHandlers[topic];
            if (!handler) {
              console.warn(`⚠️ No handler found for topic: ${topic}`);
              return;
            }

            const payload = message.value?.toString();
            if (!payload) {
              console.warn(`⚠️ Empty payload for topic: ${topic}`);
              return;
            }

            const data = JSON.parse(payload);
            console.log(`🔄 Processing ${topic} event for:`, data.adminEmail || data.email || data.companyEmail || 'unknown');
            await handler(data);
            console.log(`✅ Successfully processed ${topic} event`);
          } catch (error) {
            console.error(`❌ Failed to process ${topic} message:`, (error as any)?.message);
            console.error('Error details:', error);
          }
        },
      });
      
      console.log('✅ Kafka consumer started and ready to receive messages');
      return; // Success, exit retry loop
    } catch (error) {
      retries++;
      consumerConnected = false;
      const errorMessage = (error as any)?.message || 'Unknown error';
      console.error(`❌ Failed to connect to Kafka (attempt ${retries}/${maxRetries}):`, errorMessage);
      
      if (retries < maxRetries) {
        const waitTime = Math.min(5000 * retries, 30000); // Exponential backoff, max 30s
        console.log(`⏳ Retrying in ${waitTime / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.error('❌ Max retries reached. Kafka consumer failed to start.');
        throw error;
      }
    }
  }
};

export const disconnectKafka = async () => {
  if (!consumerConnected) return;
  await consumer.disconnect();
  consumerConnected = false;
};

// I'd like to integrate this on the dashboard:  Customer Insights
// Components: Top customers, repeat buyers, by revenue.
// Data needs: Not directly exposed; would require aggregation endpoint (currently not documented). -> no design inspiration matched / waiting on API support