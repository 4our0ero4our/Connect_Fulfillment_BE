import { Schema, Document, model } from 'mongoose';

export interface IDeletedOrderItem {
	productId: string;
	productName: string;
	quantity: number;
	price: number;
	subtotal: number;
}

export interface IDeletedCustomerInfo {
	customerName: string;
	customerEmail: string;
	customerPhone?: string;
	customerAddress?: string;
}

export interface IDeletedOrder extends Document {
	orderId: string; // original order _id
	orderNumber: string;
	companyId: string;
	companyApiKey: string;
	companyName: string;
	items: IDeletedOrderItem[];
	customerInfo: IDeletedCustomerInfo;
	ticketId?: string;
	statusBeforeDelete: string;
	totalAmount: number;
	currency: string;
	notes?: string;
	createdAtOriginal: Date;
	deletedAt: Date;
	deletedBy?: {
		adminEmail?: string;
		adminId?: string;
	};
}

const DeletedOrderItemSchema = new Schema<IDeletedOrderItem>({
	productId: { type: String, required: true },
	productName: { type: String, required: true },
	quantity: { type: Number, required: true, min: 1 },
	price: { type: Number, required: true, min: 0 },
	subtotal: { type: Number, required: true, min: 0 },
}, { _id: false });

const DeletedCustomerInfoSchema = new Schema<IDeletedCustomerInfo>({
	customerName: { type: String, required: true },
	customerEmail: { type: String, required: true, lowercase: true },
	customerPhone: { type: String, required: false },
	customerAddress: { type: String, required: false },
}, { _id: false });

const DeletedOrderSchema = new Schema<IDeletedOrder>({
	orderId: { type: String, required: true, index: true },
	orderNumber: { type: String, required: true, index: true },
	companyId: { type: String, required: true, index: true },
	companyApiKey: { type: String, required: true },
	companyName: { type: String, required: true },
	items: { type: [DeletedOrderItemSchema], required: true },
	customerInfo: { type: DeletedCustomerInfoSchema, required: true },
	ticketId: { type: String, required: false },
	statusBeforeDelete: { type: String, required: true },
	totalAmount: { type: Number, required: true },
	currency: { type: String, required: true },
	notes: { type: String, required: false },
	createdAtOriginal: { type: Date, required: true },
	deletedAt: { type: Date, required: true, default: () => new Date() },
	deletedBy: {
		adminEmail: { type: String, required: false },
		adminId: { type: String, required: false },
	},
}, { timestamps: true, collection: 'deleted_orders' });

DeletedOrderSchema.index({ companyId: 1, deletedAt: -1 });
DeletedOrderSchema.index({ orderNumber: 1 });

export const DeletedOrder = model<IDeletedOrder>('DeletedOrder', DeletedOrderSchema);
