import { Order, OrderStatus } from '../models/Order';
import mongoose from 'mongoose';
import axios from 'axios';

interface ICompany {
  _id: string;
  companyApiKey: string;
  orderDeletionSettings?: {
    enabled: boolean;
    daysToDelete: number;
    deletionTime: string; // Format: "HH:mm"
  };
}

/**
 * Scheduled job to automatically mark orders as deleted based on merchant settings
 * This runs every hour to check if it's time to delete orders for any company
 */
export const scheduleOrderDeletion = () => {
  // Run every hour
  setInterval(async () => {
    try {
      await checkAndDeleteOrders();
    } catch (error) {
      console.error('Error in order deletion scheduler:', error);
    }
  }, 60 * 60 * 1000); // 1 hour in milliseconds

  // Also run immediately on startup (after a short delay to ensure DB connection)
  setTimeout(async () => {
    try {
      await checkAndDeleteOrders();
    } catch (error) {
      console.error('Error in initial order deletion check:', error);
    }
  }, 5000); // 5 seconds delay

  console.log('Order deletion scheduler started');
};

/**
 * Check all companies and delete orders based on their settings
 */
const checkAndDeleteOrders = async () => {
  try {
    const currentTime = new Date();
    const currentHour = currentTime.getHours();
    const currentMinute = currentTime.getMinutes();
    const currentTimeString = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

    // Get all companies with order deletion enabled
    const companyServiceUrl = process.env.COMPANY_SERVICE_URL || 'http://company-service:4004';
    
    // Fetch companies with deletion settings enabled
    // Note: This requires a new endpoint in company-service to fetch companies with deletion settings
    // For now, we'll fetch all companies and filter
    let companies: ICompany[] = [];
    
    try {
      const response = await axios.get(`${companyServiceUrl}/companies-with-deletion-settings`, {
        headers: {
          'Authorization': `Bearer ${process.env.INTERNAL_SERVICE_TOKEN || ''}` // Optional internal token
        }
      });
      companies = response.data.companies || [];
    } catch (error: any) {
      // If endpoint doesn't exist yet, we'll use a fallback approach
      console.log('Company service endpoint not available, using fallback method');
      // Fallback: We'll query orders directly and check company settings from order data
      await checkOrdersDirectly(currentTimeString);
      return;
    }

    // Process each company
    for (const company of companies) {
      if (!company.orderDeletionSettings?.enabled) {
        continue;
      }

      const { daysToDelete, deletionTime } = company.orderDeletionSettings;

      // Check if it's time to run deletion for this company
      if (currentTimeString === deletionTime || isWithinDeletionWindow(currentTimeString, deletionTime)) {
        await deleteUncompletedOrders(company._id, daysToDelete);
      }
    }
  } catch (error) {
    console.error('Error checking and deleting orders:', error);
  }
};

/**
 * Fallback method: Check orders directly and delete based on company settings
 * This queries orders and checks their company's deletion settings
 */
const checkOrdersDirectly = async (currentTimeString: string) => {
  try {
    // Get all uncompleted orders older than the minimum deletion period (1 day)
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const uncompletedOrders = await Order.find({
      status: { $nin: [OrderStatus.COMPLETED, OrderStatus.DELETED] },
      createdAt: { $lt: oneDayAgo },
    }).lean();

    // Group orders by companyId
    const ordersByCompany = new Map<string, typeof uncompletedOrders>();
    for (const order of uncompletedOrders) {
      const companyId = order.companyId;
      if (!ordersByCompany.has(companyId)) {
        ordersByCompany.set(companyId, []);
      }
      ordersByCompany.get(companyId)!.push(order);
    }

    // For each company, check if we need to delete orders
    // Note: This requires fetching company settings, which we'll do via API
    const companyServiceUrl = process.env.COMPANY_SERVICE_URL || 'http://company-service:4004';
    
    for (const [companyId, orders] of ordersByCompany.entries()) {
      try {
        // Fetch company details to get deletion settings
        const response = await axios.get(`${companyServiceUrl}/company/${companyId}`, {
          headers: {
            'Authorization': `Bearer ${process.env.INTERNAL_SERVICE_TOKEN || ''}`
          }
        });

        const company = response.data.company;
        if (!company?.orderDeletionSettings?.enabled) {
          continue;
        }

        const { daysToDelete, deletionTime } = company.orderDeletionSettings;

        // Check if it's time to delete
        if (currentTimeString === deletionTime || isWithinDeletionWindow(currentTimeString, deletionTime)) {
          await deleteUncompletedOrders(companyId, daysToDelete);
        }
      } catch (error) {
        console.error(`Error fetching company ${companyId} settings:`, error);
        // Continue with next company
      }
    }
  } catch (error) {
    console.error('Error in direct order checking:', error);
  }
};

/**
 * Delete uncompleted orders for a company that are older than specified days
 */
const deleteUncompletedOrders = async (companyId: string, daysToDelete: number) => {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToDelete);

    // Find orders that:
    // 1. Belong to this company
    // 2. Are not completed
    // 3. Are not already deleted
    // 4. Are older than the cutoff date
    const ordersToDelete = await Order.find({
      companyId,
      status: { $nin: [OrderStatus.COMPLETED, OrderStatus.DELETED] },
      createdAt: { $lt: cutoffDate },
    });

    if (ordersToDelete.length === 0) {
      return;
    }

    // Mark all orders as deleted
    const orderIds = ordersToDelete.map(order => order._id);
    await Order.updateMany(
      { _id: { $in: orderIds } },
      { $set: { status: OrderStatus.DELETED } }
    );

    console.log(`Marked ${ordersToDelete.length} orders as deleted for company ${companyId}`);

    // Publish deletion events (optional, for tracking)
    for (const order of ordersToDelete) {
      try {
        // You can publish Kafka events here if needed
        console.log(`Order ${order.orderNumber} automatically deleted`);
      } catch (error) {
        console.error(`Error publishing deletion event for order ${order.orderNumber}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error deleting orders for company ${companyId}:`, error);
  }
};

/**
 * Check if current time is within deletion window (allows for 5-minute window)
 */
const isWithinDeletionWindow = (currentTime: string, deletionTime: string): boolean => {
  const [currentHour, currentMinute] = currentTime.split(':').map(Number);
  const [deletionHour, deletionMinute] = deletionTime.split(':').map(Number);

  // Allow 5-minute window
  const currentTotalMinutes = currentHour * 60 + currentMinute;
  const deletionTotalMinutes = deletionHour * 60 + deletionMinute;
  const diff = Math.abs(currentTotalMinutes - deletionTotalMinutes);

  return diff <= 5; // Within 5 minutes
};

