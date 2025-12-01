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

// Create a separate connection for AdminDB to ensure all services write audit logs to the same place
const getAdminDBUri = (): string => {
  const adminMongoUri = process.env.ADMIN_MONGO_URI;
  if (adminMongoUri) {
    return adminMongoUri;
  }
  // Fallback logic to derive AdminDB URI from MONGO_URI
  const defaultUri = process.env.MONGO_URI || 'mongodb://localhost:27017/MessagingDB';
  if (defaultUri.includes('?')) {
    const parts = defaultUri.split('?');
    const base = parts[0];
    const query = parts[1];
    const lastSlash = base.lastIndexOf('/');
    return base.substring(0, lastSlash + 1) + 'AdminDB?' + query;
  } else {
    const lastSlash = defaultUri.lastIndexOf('/');
    return defaultUri.substring(0, lastSlash + 1) + 'AdminDB';
  }
};

const adminDBConnection = mongoose.createConnection(getAdminDBUri(), {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
});

export const AuditLog = adminDBConnection.model<IAuditLog>('AuditLog', AuditLogSchema);

