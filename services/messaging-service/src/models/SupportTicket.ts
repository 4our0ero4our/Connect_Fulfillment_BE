import mongoose, { Document, Schema } from 'mongoose';

/**
 * Support ticket status enum.
 */
export enum TicketStatus {
  OPEN = 'open',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

/**
 * Support ticket interface.
 * 
 * Represents a support conversation/ticket between a merchant and FulfillMate admins.
 * Each ticket has a unique ticket number and can be assigned to a CF admin.
 */
export interface ISupportTicket extends Document {
  ticketNumber: string; // Auto-generated unique ticket number (e.g., TKT-2025-001234)
  customName?: string; // Optional custom name assigned by ticket creator
  companyId: string; // Company that created the ticket (if merchant-initiated)
  companyName: string; // Company name for display
  companyAdminEmail?: string; // Company admin email (if merchant-initiated)
  createdBy: {
    type: 'merchant' | 'cf_admin';
    userId: string;
    userEmail: string;
    userName: string;
  };
  assignedTo?: {
    cfAdminId: string;
    cfAdminEmail: string;
    cfAdminName: string;
    assignedAt: Date;
  };
  status: TicketStatus;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  category?: string; // e.g., 'api_issue', 'billing', 'feature_request', 'general'
  lastMessageAt: Date; // Timestamp of last message
  lastMessagePreview?: string; // Preview of last message for list views
  messageCount: number; // Total number of messages in this ticket
  unreadCount: {
    merchant: number; // Unread messages for merchant
    cfAdmin: number; // Unread messages for CF admin
  };
  resolvedAt?: Date; // When ticket was resolved
  closedAt?: Date; // When ticket was closed
  closedBy?: {
    type: 'merchant' | 'cf_admin';
    userId: string;
    userEmail: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const SupportTicketSchema = new Schema<ISupportTicket>(
  {
    ticketNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    customName: {
      type: String,
      maxlength: 200,
    },
    companyId: {
      type: String,
      required: true,
      index: true,
    },
    companyName: {
      type: String,
      required: true,
    },
    companyAdminEmail: {
      type: String,
      lowercase: true,
      index: true,
    },
    createdBy: {
      type: {
        type: String,
        required: true,
        enum: ['merchant', 'cf_admin'],
      },
      userId: {
        type: String,
        required: true,
      },
      userEmail: {
        type: String,
        required: true,
        lowercase: true,
      },
      userName: {
        type: String,
        required: true,
      },
    },
    assignedTo: {
      cfAdminId: {
        type: String,
      },
      cfAdminEmail: {
        type: String,
        lowercase: true,
      },
      cfAdminName: {
        type: String,
      },
      assignedAt: {
        type: Date,
      },
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(TicketStatus),
      default: TicketStatus.OPEN,
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
    },
    category: {
      type: String,
      maxlength: 100,
    },
    lastMessageAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    lastMessagePreview: {
      type: String,
      maxlength: 200,
    },
    messageCount: {
      type: Number,
      default: 0,
    },
    unreadCount: {
      merchant: {
        type: Number,
        default: 0,
      },
      cfAdmin: {
        type: Number,
        default: 0,
      },
    },
    resolvedAt: {
      type: Date,
    },
    closedAt: {
      type: Date,
    },
    closedBy: {
      type: {
        type: String,
        enum: ['merchant', 'cf_admin'],
      },
      userId: {
        type: String,
      },
      userEmail: {
        type: String,
        lowercase: true,
      },
    },
  },
  {
    timestamps: true,
    collection: 'support_tickets',
  }
);

// Compound indexes for common queries
SupportTicketSchema.index({ companyId: 1, status: 1, lastMessageAt: -1 });
SupportTicketSchema.index({ 'assignedTo.cfAdminEmail': 1, status: 1, lastMessageAt: -1 });
SupportTicketSchema.index({ status: 1, lastMessageAt: -1 });
SupportTicketSchema.index({ 'createdBy.userEmail': 1, lastMessageAt: -1 });

export const SupportTicket = mongoose.model<ISupportTicket>('SupportTicket', SupportTicketSchema);

