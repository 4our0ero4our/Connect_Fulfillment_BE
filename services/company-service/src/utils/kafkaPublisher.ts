import { Kafka } from 'kafkajs';

const kafka = new Kafka({
  clientId: 'company-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  retry: {
    retries: 8,
  },
});

const producer = kafka.producer();
let isConnected = false;
let isConnecting = false;

const ensureConnected = async () => {
  if (isConnected) return true;
  if (isConnecting) {
    await new Promise(resolve => setTimeout(resolve, 100));
    return isConnected;
  }
  isConnecting = true;
  try {
    await producer.connect();
    isConnected = true;
    return true;
  } catch (error) {
    console.error('Failed to connect Kafka producer (company-service):', (error as any)?.message || error);
    return false;
  } finally {
    isConnecting = false;
  }
};

const sendEvent = async (topic: string, payload: Record<string, unknown>) => {
  const connected = await ensureConnected();
  if (!connected) {
    console.error(`⚠️ Kafka not connected, cannot publish ${topic} event`);
    return;
  }
  try {
    await producer.send({
      topic,
      messages: [
        {
          key: (payload.companyId as string) || undefined,
          value: JSON.stringify({
            ...payload,
            eventType: topic,
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    });
    console.log(`✅ Published ${topic} event successfully`);
  } catch (error) {
    console.error(`❌ Failed to publish ${topic} event:`, (error as any)?.message || error);
    throw error; // Re-throw to allow caller to handle
  }
};

export const publishCompanyVerified = async (payload: {
  companyId: string;
  companyName: string;
  companyEmail: string;
  onboardingLink: string;
  apiKeyMasked: string;
}) => sendEvent('company_verified', payload);

export const publishCompanyApiKeyStatusChanged = async (payload: {
  companyId: string;
  companyName: string;
  companyEmail: string;
  status: 'active' | 'inactive';
  changerEmail?: string;
}) => sendEvent('company_api_key_status_changed', payload);

export const publishCompanyStatusChanged = async (payload: {
  companyId: string;
  companyName: string;
  companyEmail: string;
  isActive: boolean;
  reason?: string;
  changedBy?: string;
}) => sendEvent('company_status_changed', payload);

export const publishMerchantAdminRegistered = async (payload: {
  companyId: string;
  companyName: string;
  companyEmail: string;
  adminEmail: string;
  adminName: string;
  loginUrl?: string;
}) => sendEvent('merchant_admin_registered', payload);

export const publishCompanyAdminRemoved = async (payload: {
  companyId: string;
  companyName: string;
  companyEmail: string;
  adminEmail: string;
  removedBy: { adminEmail: string; adminName?: string };
}) => sendEvent('company_admin_removed', payload);

export const disconnectCompanyKafka = async () => {
  if (!isConnected) return;
  try {
    await producer.disconnect();
    isConnected = false;
  } catch (error) {
    console.error('Failed to disconnect Kafka producer (company-service):', (error as any)?.message || error);
  }
};

