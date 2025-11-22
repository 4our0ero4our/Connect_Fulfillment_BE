import mongoose, { Document, Schema } from 'mongoose';

/**
 * Audit log entry interface for messaging service.
 */
export interface IAuditLog extends Document {
  action: string;
  performedBy: string;
  performedByRole: 'cf_admin' | 'merchant_admin' | 'system';
  performedById?: string;
  performedByName?: string;
  targetTicket?: string;
  targetTicketNumber?: string;
  targetCompany?: string;
  targetCompanyName?: string;
  details: {
    oldValue?: any;
    newValue?: any;
    reason?: string;
    [key: string]: any;
  };
  timestamp: Date;
  ipAddress?: string;
  userAgent?: string;
  service: string;
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
    targetTicket: {
      type: String,
      index: true,
    },
    targetTicketNumber: {
      type: String,
      index: true,
    },
    targetCompany: {
      type: String,
      index: true,
    },
    targetCompanyName: {
      type: String,
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
      default: 'messaging-service',
      index: true,
    },
  },
  {
    timestamps: false,
    collection: 'audit_logs',
  }
);

AuditLogSchema.index({ targetTicket: 1, timestamp: -1 });
AuditLogSchema.index({ performedBy: 1, timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });

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

