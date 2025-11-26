import { Schema, model, Document } from 'mongoose';

export interface IAdminSession extends Document {
  adminId: string;
  adminEmail: string;
  adminName: string;
  refreshTokenHash: string;
  userAgent?: string;
  ipAddress?: string;
  expiresAt: Date;
  lastUsedAt?: Date;
  createdAt: Date;
}

const AdminSessionSchema = new Schema<IAdminSession>(
  {
    adminId: { type: String, required: true, index: true },
    adminEmail: { type: String, required: true, lowercase: true, index: true },
    adminName: { type: String, required: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    userAgent: { type: String },
    ipAddress: { type: String },
    expiresAt: { type: Date, required: true, index: true },
    lastUsedAt: { type: Date },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

AdminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminSession = model<IAdminSession>('AdminSession', AdminSessionSchema);

