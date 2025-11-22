import mongoose, { Document, Schema } from 'mongoose';

/**
 * Message interface.
 * 
 * Represents an individual message within a support ticket conversation.
 */
export interface IMessage extends Document {
  ticketId: string; // Reference to SupportTicket _id
  ticketNumber: string; // Ticket number for quick reference
  senderType: 'merchant' | 'cf_admin';
  senderId: string; // User ID (company admin ID or CF admin ID)
  senderEmail: string; // Sender email
  senderName: string; // Sender name for display
  content: string; // Message content
  read: boolean; // Whether message has been read
  readAt?: Date; // When message was read
  readBy?: {
    userId: string;
    userEmail: string;
    readAt: Date;
  }[]; // Array of readers (for group scenarios)
  attachments?: Array<{
    filename: string;
    url: string;
    type: string; // MIME type
    size: number; // File size in bytes
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    ticketId: {
      type: String,
      required: true,
      index: true,
    },
    ticketNumber: {
      type: String,
      required: true,
      index: true,
    },
    senderType: {
      type: String,
      required: true,
      enum: ['merchant', 'cf_admin'],
      index: true,
    },
    senderId: {
      type: String,
      required: true,
    },
    senderEmail: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    senderName: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      required: true,
      maxlength: 10000, // 10KB max message length
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
    },
    readBy: {
      type: [
        {
          userId: String,
          userEmail: String,
          readAt: Date,
        },
      ],
      default: [],
    },
    attachments: {
      type: [
        {
          filename: String,
          url: String,
          type: String,
          size: Number,
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    collection: 'messages',
  }
);

// Compound indexes for common queries
MessageSchema.index({ ticketId: 1, createdAt: -1 });
MessageSchema.index({ ticketNumber: 1, createdAt: -1 });
MessageSchema.index({ senderEmail: 1, createdAt: -1 });
MessageSchema.index({ read: 1, createdAt: -1 });

export const Message = mongoose.model<IMessage>('Message', MessageSchema);

