import { Schema, model, Document } from 'mongoose';

export type NotificationStatus = 'queued' | 'sent' | 'failed';
export type NotificationChannel = 'email' | 'sms';

export interface INotification extends Document {
  category: string;
  trigger: string;
  channel: NotificationChannel;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; path?: string; content?: string }>;
  meta?: Record<string, unknown>;
  status: NotificationStatus;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    category: { type: String, required: true, index: true },
    trigger: { type: String, required: true },
    channel: { type: String, enum: ['email', 'sms'], default: 'email' },
    to: { type: [String], required: true },
    subject: { type: String, required: true },
    text: { type: String },
    html: { type: String },
    attachments: { type: [Schema.Types.Mixed], default: [] },
    meta: { type: Schema.Types.Mixed },
    status: { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' },
    errorMessage: { type: String },
  },
  {
    timestamps: true,
    collection: 'notifications',
  }
);

NotificationSchema.index({ createdAt: -1 });

export const Notification = model<INotification>('Notification', NotificationSchema);
