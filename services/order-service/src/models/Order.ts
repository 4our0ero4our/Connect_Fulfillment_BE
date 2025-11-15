import { Schema, Document, model } from 'mongoose';

// Order item interface
export interface IOrderItem {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  subtotal: number;
}

// Customer information interface
export interface ICustomerInfo {
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  customerAddress?: string;
}

// Order status enum
export enum OrderStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  PACKED = 'packed',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  DELETED = 'deleted',
}

// Order document interface
export interface IOrder extends Document {
  orderNumber: string; // Unique order number (e.g., ORD-2025-001234)
  companyId: string; // Reference to Company _id
  companyApiKey: string; // Store API key for quick lookups
  companyName: string; // Store company name for quick access
  items: IOrderItem[];
  customerInfo: ICustomerInfo;
  ticketId?: string; // Reference to ticket/QR code (if applicable)
  status: OrderStatus;
  totalAmount: number;
  currency: string;
  notes?: string; // Additional order notes
  createdAt: Date;
  updatedAt: Date;
}

const OrderItemSchema = new Schema<IOrderItem>(
  {
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    subtotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const CustomerInfoSchema = new Schema<ICustomerInfo>(
  {
    customerName: { type: String, required: true },
    customerEmail: { type: String, required: true, lowercase: true, match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'] },
    customerPhone: { type: String, required: false },
    customerAddress: { type: String, required: false },
  },
  { _id: false }
);

const OrderSchema: Schema = new Schema<IOrder>(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    companyId: {
      type: String,
      required: true,
      index: true, // Index for faster queries by company
    },
    companyApiKey: {
      type: String,
      required: true,
      index: true, // Index for faster API key lookups
    },
    companyName: {
      type: String,
      required: true,
    },
    items: {
      type: [OrderItemSchema],
      required: true,
      validate: {
        validator: (items: IOrderItem[]) => items.length > 0,
        message: 'Order must have at least one item',
      },
    },
    customerInfo: {
      type: CustomerInfoSchema,
      required: true,
    },
    ticketId: {
      type: String,
      required: false,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(OrderStatus),
      default: OrderStatus.PENDING,
      required: true,
      index: true, // Index for status filtering
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'USD',
      required: true,
    },
    notes: {
      type: String,
      required: false,
    },
  },
  {
    timestamps: true,
    collection: 'orders',
  }
);

// Compound indexes for common query patterns
OrderSchema.index({ companyId: 1, status: 1 }); // For filtering orders by company and status
OrderSchema.index({ companyId: 1, createdAt: -1 }); // For getting company orders sorted by date
OrderSchema.index({ status: 1, createdAt: -1 }); // For filtering by status and sorting by date
OrderSchema.index({ 'customerInfo.customerEmail': 1, createdAt: -1 }); // For customer order queries
OrderSchema.index({ createdAt: -1 }); // For sorting by date (general)

// Generate unique order number before saving
// Using a combination of timestamp and random number to ensure uniqueness
OrderSchema.pre<IOrder>('validate', function (next) {
  if (!this.orderNumber) {
    const year = new Date().getFullYear();
    const timestamp = Date.now().toString().slice(-6); 
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    this.orderNumber = `ORD-${year}-${timestamp}${random}`;
  }
  next();
});

export const Order = model<IOrder>('Order', OrderSchema);

