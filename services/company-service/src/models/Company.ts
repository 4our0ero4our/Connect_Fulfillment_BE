import { Schema, Document, model } from 'mongoose';

export interface ICompany extends Document {
  companyName: string;
  companyEmail: string;
  companyAddress: string;
  companyPhone: number;
  companyWebsite: string;
  companyLogo: string;
  companyDescription: string;
  companyCategory: string;
  companySubCategory: string;
  companyApiKey: string;
}

const CompanySchema: Schema = new Schema<ICompany>(
  {
    companyName: { type: String, required: true },
    companyEmail: { type: String, required: true, unique: true, lowercase: true, match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'] },
    companyAddress: { type: String, required: true },
    companyPhone: { type: Number, required: true },
    companyWebsite: { type: String, required: true },
    companyLogo: { type: String, required: true },
    companyDescription: { type: String, required: true },
    companyCategory: { type: String, required: true },
    companySubCategory: { type: String, required: true },
    // An API Key will be automatically generated on sign up, that's why it's required. An admin is gonna get it for them through mail after verifying the company.
    // companyApiKey: { type: String, required: true, unique: true },
    companyApiKey: { type: String, required: false, unique: true },
  },
  { timestamps: true }
);

export const Company = model<ICompany>('Company', CompanySchema);