# Ticket Service Integration Guide

This document explains how the Ticket Service should integrate with the Order Service to generate and attach tickets to orders.

## Flow Overview

1. **Order Created**: Customer places order → Order Service publishes `order_created` event
2. **Order Status Updated**: Merchant admin updates order status to "packed" → Order Service publishes `order_status_updated` event
3. **Ticket Generation**: Ticket Service consumes `order_status_updated` event when `status === "packed"` → Generates ticket
4. **Ticket Attached**: Ticket Service calls Order Service API to attach `ticketId` to order
5. **Notification Sent**: Order Service publishes `ticket_attached_to_order` event → Notification Service sends email with QR code

## Kafka Events Consumed by Ticket Service

### 1. `order_status_updated` Event

**Topic**: `order_status_updated`

**When to Consume**: Listen for events where `newStatus === "packed"`

**Event Structure**:
```json
{
  "orderId": "507f1f77bcf86cd799439011",
  "orderNumber": "ORD-2025-123456789",
  "companyId": "507f1f77bcf86cd799439012",
  "companyName": "Sunrise Supermarket",
  "companyEmail": "sunrise@supermarket.com",
  "customerInfo": {
    "customerName": "John Doe",
    "customerEmail": "john@example.com",
    "customerPhone": "+2348012345678",
    "customerAddress": "123 Main St, Lagos"
  },
  "items": [
    {
      "productId": "prod_123",
      "productName": "Product Name",
      "quantity": 2,
      "price": 1500.00
    }
  ],
  "totalAmount": 3000.00,
  "currency": "NGN",
  "oldStatus": "processing",
  "newStatus": "packed",
  "ticketId": null,
  "updatedAt": "2025-01-07T12:30:00.000Z",
  "timestamp": "2025-01-07T12:30:00.000Z",
  "eventType": "order_status_updated"
}
```

**Ticket Service Action**:
- When `newStatus === "packed"` and `ticketId === null`, generate a new ticket
- Create ticket document in tickets collection
- Generate ticket ID (to be embedded in QR code)
- Call Order Service API to attach ticket to order (see below)

**Other Status Values**:
- `newStatus === "processing"` → Send status update email to customer (via Notification Service)
- `newStatus === "cancelled"` → Send cancellation email to customer
- `newStatus === "completed"` → Send completion email to customer

## Order Service API Endpoint

### Attach Ticket to Order

**Endpoint**: `PATCH /orders/:orderId/ticket`

**Base URL**: 
- Through API Gateway: `http://localhost:4000/orders/:orderId/ticket`
- Direct to Order Service: `http://localhost:4002/orders/:orderId/ticket`

**Authentication**: 
- Currently open (no authentication required for internal service calls)
- **TODO**: Add internal service token authentication when implementing Ticket Service

**Request Headers**:
```http
Content-Type: application/json
```

**Request Body**:
```json
{
  "ticketId": "TICKET_XYZ123456"
}
```

**Response (200)**:
```json
{
  "message": "Ticket attached to order successfully",
  "order": {
    "id": "507f1f77bcf86cd799439011",
    "orderNumber": "ORD-2025-123456789",
    "ticketId": "TICKET_XYZ123456",
    "oldTicketId": null,
    "status": "packed",
    "updatedAt": "2025-01-07T12:35:00.000Z"
  }
}
```

**Error Responses**:
- `400`: Validation error (missing ticketId, ticket already attached, order status not "packed")
- `404`: Order not found
- `500`: Internal server error

**Validation Rules**:
1. `ticketId` is required and must be a string
2. Order must exist
3. Order status must be "packed" (tickets can only be attached to packed orders)
4. Ticket cannot be already attached to the order

## Kafka Events Published by Order Service

### 1. `order_created`
- Published when a new order is created
- Status: `pending`
- No ticket generated yet

### 2. `order_status_updated`
- Published when order status changes
- Includes full order details (customer info, items, company info)
- Ticket Service consumes this to generate tickets when `status === "packed"`

### 3. `ticket_attached_to_order`
- Published when Ticket Service attaches a ticketId to an order
- Notification Service consumes this to send QR code emails

**Event Structure**:
```json
{
  "orderId": "507f1f77bcf86cd799439011",
  "orderNumber": "ORD-2025-123456789",
  "companyId": "507f1f77bcf86cd799439012",
  "companyName": "Sunrise Supermarket",
  "ticketId": "TICKET_XYZ123456",
  "customerInfo": {
    "customerName": "John Doe",
    "customerEmail": "john@example.com",
    "customerPhone": "+2348012345678"
  },
  "items": [...],
  "totalAmount": 3000.00,
  "currency": "NGN",
  "status": "packed",
  "attachedAt": "2025-01-07T12:35:00.000Z",
  "timestamp": "2025-01-07T12:35:00.000Z",
  "eventType": "ticket_attached_to_order"
}
```

## Implementation Checklist for Ticket Service

- [ ] Set up Kafka consumer for `order_status_updated` topic
- [ ] Filter events where `newStatus === "packed"` and `ticketId === null`
- [ ] Generate unique ticket ID
- [ ] Create ticket document in tickets collection
- [ ] Generate QR code with ticket ID embedded
- [ ] Call Order Service API to attach ticket to order: `PATCH /orders/:orderId/ticket`
- [ ] Handle errors (order not found, status changed, etc.)
- [ ] Publish `ticket_generated` event (if needed for Notification Service)
- [ ] Store QR code image/data for customer email

## Order Status Flow

```
pending → processing → packed → ready_for_pickup → completed
                            ↓
                      (Ticket generated here)
                            ↓
                      (QR code sent to customer)
```

## Notification Service Integration

Notification Service should consume:
1. **`order_status_updated`**: Send status update emails for statuses like "processing", "cancelled", "completed"
2. **`ticket_attached_to_order`**: Send QR code email to customer with pickup instructions

## Error Handling

- If order status changes from "packed" to something else before ticket is attached, the ticket attachment will fail (expected behavior)
- If ticket attachment fails, Ticket Service should log error and optionally retry or notify admin
- Order Service will validate that order status is "packed" before attaching ticket

## Testing

1. Create an order (status: "pending")
2. Update order status to "processing" (verify `order_status_updated` event)
3. Update order status to "packed" (verify `order_status_updated` event with `newStatus: "packed"`)
4. Ticket Service generates ticket and calls `PATCH /orders/:orderId/ticket`
5. Verify `ticket_attached_to_order` event is published
6. Verify order now has `ticketId` field populated

