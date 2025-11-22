import mongoose, { Document, Schema } from 'mongoose';

/**
 * Audit log entry interface.
 * 
 * Represents an immutable audit trail of all actions performed in the system.
 * Logs cannot be modified or deleted by anyone, including Lead Admins.
 */
export interface IAuditLog extends Document {
  action: string; // e.g., 'company_verified', 'admin_added', 'order_status_updated'
  performedBy: string; // Email of the user who performed the action
  performedByRole: 'cf_admin' | 'merchant_admin' | 'system'; // Role of the performer
  performedById?: string; // ID of the user (optional, for reference)
  performedByName?: string; // Name of the user (optional, for display)
  
  // Target entity information (optional, depends on action)
  targetCompany?: string; // Company ID if action affects a company
  targetCompanyName?: string; // Company name for display
  targetOrder?: string; // Order ID if action affects an order
  targetOrderNumber?: string; // Order number for display
  targetTicket?: string; // Ticket ID if action affects a ticket
  targetAdmin?: string; // Admin email if action affects an admin
  targetStaff?: string; // Staff email if action affects staff
  
  // Action details
  details: {
    // Action-specific data (flexible object)
    oldValue?: any;
    newValue?: any;
    reason?: string;
    [key: string]: any; // Allow additional fields
  };
  
  // Metadata
  timestamp: Date; // Exact date and time of the action
  ipAddress?: string; // IP address of the requester (optional)
  userAgent?: string; // User agent string (optional)
  service: string; // Service that created the log (e.g., 'order-service', 'company-service')
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    action: {
      type: String,
      required: true,
      index: true,
    },
    performedBy: {
      type: String,
      required: true,
      index: true,
      lowercase: true,
    },
    performedByRole: {
      type: String,
      required: true,
      enum: ['cf_admin', 'merchant_admin', 'system'],
      index: true,
    },
    performedById: {
      type: String,
      index: true,
    },
    performedByName: {
      type: String,
    },
    targetCompany: {
      type: String,
      index: true,
    },
    targetCompanyName: {
      type: String,
    },
    targetOrder: {
      type: String,
      index: true,
    },
    targetOrderNumber: {
      type: String,
    },
    targetTicket: {
      type: String,
      index: true,
    },
    targetAdmin: {
      type: String,
      index: true,
    },
    targetStaff: {
      type: String,
      index: true,
    },
    details: {
      type: Schema.Types.Mixed,
      required: true,
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    ipAddress: {
      type: String,
    },
    userAgent: {
      type: String,
    },
    service: {
      type: String,
      required: true,
      index: true,
    },
  },
  {
    timestamps: false, // We use custom timestamp field for exact control
    collection: 'audit_logs',
  }
);

// Compound indexes for common queries
AuditLogSchema.index({ targetCompany: 1, timestamp: -1 });
AuditLogSchema.index({ performedBy: 1, timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });
AuditLogSchema.index({ service: 1, timestamp: -1 });
AuditLogSchema.index({ timestamp: -1 }); // Default sort by most recent

// Prevent updates and deletes
AuditLogSchema.pre('findOneAndUpdate', function () {
  throw new Error('Audit logs cannot be updated');
});

AuditLogSchema.pre('updateOne', function () {
  throw new Error('Audit logs cannot be updated');
});

AuditLogSchema.pre('deleteOne', function () {
  throw new Error('Audit logs cannot be deleted');
});

AuditLogSchema.pre('findOneAndDelete', function () {
  throw new Error('Audit logs cannot be deleted');
});

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);

