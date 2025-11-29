import { Schema, Document, model } from 'mongoose';
import mongoose from 'mongoose';

export interface ICompany extends Document {
  companyName: string;
  companyEmail: string;
  companyAddress: string;
  companyPhone: number;
  companyWebsite: string; 
  companyLogo: string;
  companyDescription: string; // Description is what the company does or what it offers.
  companyDetails: string; // Details is more detailed information about a company like what products they sell, what services they offer, what their target audience is and maybe some statisctics to convince us to let them integrate our service coz we can be hard sometimes just to not allow scammers, you know? 😂
  companyCategory: string;
  companySubCategory: string;
  companyApiKey: string;
  apiKeyActive: boolean;
  isVerified: boolean;
  isActive: boolean;
  isServiceActive: boolean; // Whether the company is currently accepting orders (can be toggled by company admin)
  deliveryTimeHours: number; // Number of hours after order placement when order will be ready (e.g., 2 for "ready in 2 hours")
  companyAdminEmails: string[];
  companyAdminIDDetails: { companyAdminName: string, companyAdminEmail: string, companyAdminPassword: string }[];
  serviceSchedule?: {
    enabled: boolean; // Whether schedule-based availability is enabled
    schedule: {
      monday: { enabled: boolean; startTime: string; endTime: string };
      tuesday: { enabled: boolean; startTime: string; endTime: string };
      wednesday: { enabled: boolean; startTime: string; endTime: string };
      thursday: { enabled: boolean; startTime: string; endTime: string };
      friday: { enabled: boolean; startTime: string; endTime: string };
      saturday: { enabled: boolean; startTime: string; endTime: string };
      sunday: { enabled: boolean; startTime: string; endTime: string };
    };
  };
  orderDeletionSettings?: {
    enabled: boolean;
    daysToDelete: number; // Number of days after which uncompleted orders should be deleted
    deletionTime: string; // Time of day to run deletion (format: "HH:mm" in 24-hour format, e.g., "21:00" for 9pm)
  };
  onboardingTokenHash?: string | null;
  onboardingTokenExpiresAt?: Date | null;
  onboardingTokenUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CompanySchema: Schema = new Schema<ICompany>(
  {
    companyName: { type: String, required: true },
    companyEmail: { type: String, required: true, unique: true, lowercase: true, match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'] },
    companyAddress: { type: String, required: true },
    companyPhone: { type: Number, required: true, unique: true, match: [/^\d{10}$/, 'Please enter a valid 10-digit phone number'] },
    companyWebsite: { type: String, required: true, match: [/^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/, 'Please enter a valid website URL'] },
    companyLogo: { type: String, required: true, match: [/^(http|https):\/\/.+\.(jpg|jpeg|png|gif|bmp|tiff|ico|webp|svg|heic|heif)$/i, 'Please upload a valid image file'] },
    companyDescription: { type: String, required: true, minlength: 10, maxlength: 1000 },
    companyDetails: { type: String, required: true, minLength: [100, 'Company details must be at least 100 characters'], maxLength: [1000, 'Company details must be less than 1000 characters']},
    companyCategory: { type: String, required: true, enum: ['Electronics', 'Clothing', 'Furniture', 'Other'] },
    companySubCategory: { type: String, required: true, enum: ['Electronics', 'Clothing', 'Furniture', 'Other'] },
    companyApiKey: { type: String, unique: true, sparse: true }, // Admin generates the API key for the company from the admin dashboard after approval of the company and will get it sent to them through mail afterwards.
    apiKeyActive: { type: Boolean, default: true },
    // A Connect Fulfillment admin will verify the company after they register themselves then change their status to true.
    isVerified: { type: Boolean, default: false, required: true },
    isActive: { type: Boolean, default: true },
    isServiceActive: { type: Boolean, default: true }, // Company can toggle this to stop receiving orders (e.g., when closing store)
    deliveryTimeHours: { type: Number, default: 2, min: [0.5, 'Delivery time must be at least 0.5 hours'], max: [168, 'Delivery time cannot exceed 168 hours (7 days)'] }, // Default 2 hours, min 0.5 hours (30 mins), max 7 days
    companyAdminEmails: { type: [String], default: [], required: true},
    companyAdminIDDetails: { type: [{ companyAdminName: String, companyAdminEmail: String, companyAdminPassword: String }], default: [], required: true},
    serviceSchedule: {
      type: {
        enabled: { type: Boolean, default: false },
        schedule: {
          type: {
            monday: {
              type: {
                enabled: { type: Boolean, default: false },
                startTime: { type: String, default: '09:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] },
                endTime: { type: String, default: '17:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] }
              },
              required: false
            },
            tuesday: {
              type: {
                enabled: { type: Boolean, default: false },
                startTime: { type: String, default: '09:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] },
                endTime: { type: String, default: '17:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] }
              },
              required: false
            },
            wednesday: {
              type: {
                enabled: { type: Boolean, default: false },
                startTime: { type: String, default: '09:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] },
                endTime: { type: String, default: '17:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] }
              },
              required: false
            },
            thursday: {
              type: {
                enabled: { type: Boolean, default: false },
                startTime: { type: String, default: '09:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] },
                endTime: { type: String, default: '17:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] }
              },
              required: false
            },
            friday: {
              type: {
                enabled: { type: Boolean, default: false },
                startTime: { type: String, default: '09:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] },
                endTime: { type: String, default: '17:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] }
              },
              required: false
            },
            saturday: {
              type: {
                enabled: { type: Boolean, default: false },
                startTime: { type: String, default: '09:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] },
                endTime: { type: String, default: '17:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] }
              },
              required: false
            },
            sunday: {
              type: {
                enabled: { type: Boolean, default: false },
                startTime: { type: String, default: '09:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] },
                endTime: { type: String, default: '17:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] }
              },
              required: false
            }
          },
          required: false
        }
      },
      required: false
    },
    orderDeletionSettings: {
      type: {
        enabled: { type: Boolean, default: false },
        daysToDelete: { type: Number, default: 3, min: 1 }, // Minimum 1 day
        deletionTime: { type: String, default: '21:00', match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please enter a valid time in HH:mm format (24-hour)'] }, // Format: "HH:mm"
      },
      required: false,
    },
    onboardingTokenHash: { type: String, required: false, select: false },
    onboardingTokenExpiresAt: { type: Date, required: false },
    onboardingTokenUsedAt: { type: Date, required: false },
  },
  { timestamps: true }
);

// Create index on companyApiKey for faster lookups
CompanySchema.index({ companyApiKey: 1 }, { unique: true, sparse: true });

export const Company = model<ICompany>('Company', CompanySchema);