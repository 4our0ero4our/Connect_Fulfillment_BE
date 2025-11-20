import { Schema, model, Document } from 'mongoose';

export enum TicketStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  INVALID = 'invalid',
  EXPIRED = 'expired',
}

export interface ITicketHolder {
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
}

export interface IValidationRecord {
  status: TicketStatus;
  validatedAt: Date;
  validatorEmail?: string;
  validatorId?: string;
  validatorRole?: 'cf_admin' | 'merchant_admin' | 'store_admin';
  location?: string;
  notes?: string;
}

export interface ITicket extends Document {
  ticketId: string;
  orderId: string;
  orderNumber?: string;
  companyId: string;
  companyName: string;
  companyApiKey?: string;
  status: TicketStatus;
  qrPayload: string;
  qrCode?: string;
  issuedTo: ITicketHolder;
  expiresAt?: Date;
  activatedAt?: Date;
  validatedAt?: Date;
  validationHistory: IValidationRecord[];
  lastValidatorEmail?: string;
  lastValidatorId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const TicketHolderSchema = new Schema<ITicketHolder>(
  {
    customerName: { type: String, required: true },
    customerEmail: {
      type: String,
      required: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    customerPhone: { type: String, required: false },
  },
  { _id: false }
);

const ValidationRecordSchema = new Schema<IValidationRecord>(
  {
    status: {
      type: String,
      enum: Object.values(TicketStatus),
      required: true,
    },
    validatedAt: { type: Date, required: true, default: Date.now },
    validatorEmail: { type: String },
    validatorId: { type: String },
    validatorRole: {
      type: String,
      enum: ['cf_admin', 'merchant_admin', 'store_admin'],
    },
    location: { type: String },
    notes: { type: String },
  },
  { _id: false }
);

const TicketSchema = new Schema<ITicket>(
  {
    ticketId: { type: String, required: true, unique: true, index: true },
    orderId: { type: String, required: true, unique: true, index: true },
    orderNumber: { type: String },
    companyId: { type: String, required: true, index: true },
    companyName: { type: String, required: true },
    companyApiKey: { type: String },
    status: {
      type: String,
      enum: Object.values(TicketStatus),
      default: TicketStatus.PENDING,
      index: true,
    },
    qrPayload: { type: String, required: true },
    qrCode: { type: String },
    issuedTo: { type: TicketHolderSchema, required: true },
    expiresAt: { type: Date },
    activatedAt: { type: Date },
    validatedAt: { type: Date },
    validationHistory: {
      type: [ValidationRecordSchema],
      default: [],
    },
    lastValidatorEmail: { type: String },
    lastValidatorId: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: 'tickets',
  }
);

TicketSchema.index({ companyId: 1, status: 1, createdAt: -1 });
TicketSchema.index({ ticketId: 1, companyId: 1 });
TicketSchema.index({ 'issuedTo.customerEmail': 1, createdAt: -1 });

export const Ticket = model<ITicket>('Ticket', TicketSchema);
