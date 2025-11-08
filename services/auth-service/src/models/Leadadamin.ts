import { Schema, Document, model } from 'mongoose';
import mongoose from 'mongoose';

export interface ILeadAdmin extends Document {
  leadAdminName: string;
  leadAdminEmail: string;
  leadAdminPassword: string;
}

const LeadAdminSchema: Schema = new Schema<ILeadAdmin>(
  {
    leadAdminName: { type: String, required: true },
    leadAdminEmail: { type: String, required: true, unique: true, lowercase: true, match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'] },
    leadAdminPassword: { type: String, required: true },
  },
  { timestamps: true, collection: 'leadadmins' }
);

export const LeadAdmin = mongoose.model<ILeadAdmin>('LeadAdmin', LeadAdminSchema);