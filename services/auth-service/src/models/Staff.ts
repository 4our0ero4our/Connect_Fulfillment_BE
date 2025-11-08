import { Schema, Document, model } from 'mongoose';
import mongoose from 'mongoose';

export interface IStaff extends Document {
  name: string;
  email: string;
  role: string;
  canBeCFAdmin: boolean;
  isALeadCFAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const StaffSchema: Schema = new Schema<IStaff>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'] },
    role: { type: String, required: true, enum: ['admin', 'staff'] },
    canBeCFAdmin: { type: Boolean, required: true, default: false }, // This is to check if the staff can be a Connect Fulfillment admin or not.
    isALeadCFAdmin: { type: Boolean, required: true, default: false }, // This is to check if the staff is a lead Connect Fulfillment admin or not (Only the lead Connect Fulfillment admins can add a new staff and also delete them (HR PeopleType Shii, you know? 😂))
  },
  { timestamps: true, collection: 'staffs' }
);
export const Staff = mongoose.model<IStaff>('Staff', StaffSchema);