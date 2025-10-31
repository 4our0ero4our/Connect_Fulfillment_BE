// This model is strictly for the admins that will be managing the Connect Fulfillment Platform, and perform tasks like changing the API key for a company, checking companies, deactivating or activating companies in case there's any issue, checking the companies that just applied for onboarding, approving or rejecting their application for onboarding, etc.

import mongoose, { Schema, Document } from 'mongoose';

export interface IAdmin extends Document {
  _id: mongoose.Types.ObjectId;
  adminName?: string;
  adminEmail?: string;
  password?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const AdminSchema: Schema = new Schema<IAdmin>(
  {
    _id: { type: Schema.Types.ObjectId, default: new mongoose.Types.ObjectId() },
    adminName: { type: String, required: false },
    adminEmail: { type: String, required: true, unique: true, lowercase: true, match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'] },
    password: { type: String, required: true },
  },
  { timestamps: true, collection: 'admins' }
);
export const Admin = mongoose.model<IAdmin>('Admin', AdminSchema);
