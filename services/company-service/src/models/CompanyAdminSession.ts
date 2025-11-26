import { Schema, Document, model } from 'mongoose';

export interface ICompanyAdminSession extends Document {
  companyAdminEmail: string;
  companyAdminName?: string;
  companyId: string;
  refreshTokenHash: string;
  userAgent?: string;
  ipAddress?: string;
  expiresAt: Date;
  lastUsedAt?: Date;
  createdAt: Date;
}

const CompanyAdminSessionSchema = new Schema<ICompanyAdminSession>(
  {
    companyAdminEmail: { type: String, required: true, lowercase: true, index: true },
    companyAdminName: { type: String },
    companyId: { type: String, required: true, index: true },
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

// Automatically purge expired sessions
CompanyAdminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CompanyAdminSession = model<ICompanyAdminSession>('CompanyAdminSession', CompanyAdminSessionSchema);

