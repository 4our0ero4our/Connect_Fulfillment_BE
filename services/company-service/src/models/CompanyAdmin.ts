// This is the model for each merchant/company's account admins. It will be used to login to their dashboards to see their orders, inventory, customers, etc.

import mongoose, { Schema, Document } from 'mongoose';

export interface ICompanyAdmin extends Document {
  companyId: string;
  companyName: string;
  companyAdminName: string;
  companyAdminEmail: string;
  companyAdminPassword: string;
}

const CompanyAdminSchema: Schema = new Schema<ICompanyAdmin>(
  {
    companyId: { type: String, required: true, index: true },
    companyName: { type: String, required: true },
    companyAdminName: { type: String, required: true },
    companyAdminEmail: { type: String, required: true, unique: true, lowercase: true, match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'], index: true },
    companyAdminPassword: { type: String, required: true, minlength: [8, 'Password must be at least 8 characters long'] },
  },
  { timestamps: true }
)

// Create indexes for efficient queries
CompanyAdminSchema.index({ companyId: 1, companyAdminEmail: 1 });

export const CompanyAdmin = mongoose.model<ICompanyAdmin>('CompanyAdmin', CompanyAdminSchema);