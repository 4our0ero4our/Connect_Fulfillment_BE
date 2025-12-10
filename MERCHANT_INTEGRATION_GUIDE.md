# Connect Fulfillment Integration Guide

A simple guide to integrate Connect Fulfillment into your existing e-commerce platform.

---

## 📋 Table of Contents

1. [Getting Started](#getting-started)
2. [Integration Overview](#integration-overview)
3. [Step-by-Step Integration](#step-by-step-integration)
4. [What to Send](#what-to-send)
5. [What You'll Receive](#what-youll-receive)
6. [Code Examples](#code-examples)
7. [Error Handling](#error-handling)
8. [Testing](#testing)

---

## Getting Started

### Prerequisites

Before you begin, you need:

1. **Your API Key** - You'll receive this after your company is verified
2. **API Endpoint** - `https://api.fulfillmate.com/order` (or your provided endpoint)
3. **HTTPS** - All API calls must use HTTPS for security

### Getting Your API Key

1. Register your company on Connect Fulfillment
2. Wait for verification (usually 1-2 business days)
3. Check your email for the onboarding link
4. Click the link to retrieve your API key
5. **Important**: Store your API key securely - you'll only see it once!

---

## Integration Overview

### How It Works

```
Customer Checkout Flow:
1. Customer adds items to cart
2. Customer clicks "Check out with Connect Fulfillment"
3. Customer completes payment on your platform
4. After successful payment → Send order to Connect Fulfillment API
5. Receive order confirmation with order number
6. Customer receives email with QR ticket automatically
```

### The Button

Add a button in your checkout page that says:
- **"Check out with Connect Fulfillment"** or
- **"Fulfill with Connect Fulfillment"** or
- **"Complete Order"** (if Connect Fulfillment is your only fulfillment option)

---

## Step-by-Step Integration

### Step 1: Add the Checkout Button

Add a button to your checkout page that triggers the fulfillment process after payment is successful.

**Example HTML:**
```html
<button id="fulfillment-btn" onclick="createFulfillmentOrder()">
  Check out with Connect Fulfillment
</button>
```

### Step 2: Process Payment First

**Important**: Always process the customer's payment on your platform first. Only send the order to Connect Fulfillment after payment is confirmed.

### Step 3: Send Order to Connect Fulfillment

After payment is successful, make an API call to create the order in Connect Fulfillment.

---

## What to Send

### API Endpoint
```
POST https://api.fulfillmate.com/order
```

### Required Headers
```http
your_company_api_key: YOUR_API_KEY_HERE
Content-Type: application/json
```

### Request Body

Send the following data after payment is successful:

```json
{
  "items": [
    {
      "productId": "prod_123",
      "productName": "Product Name",
      "quantity": 2,
      "price": 1500.00
    }
  ],
  "customerInfo": {
    "customerName": "John Doe",
    "customerEmail": "john@example.com",
    "customerPhone": "+2348012345678",
    "customerAddress": "123 Main St, Lagos"
  },
  "notes": "Special delivery instructions",
  "currency": "NGN"
}
```

### Field Descriptions

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| **items** | ✅ Yes | Array of products in the order | See below |
| **items[].productId** | ✅ Yes | Your product identifier | `"prod_123"` |
| **items[].productName** | ✅ Yes | Product name | `"Blue T-Shirt"` |
| **items[].quantity** | ✅ Yes | Quantity (minimum 1) | `2` |
| **items[].price** | ✅ Yes | Price per item | `1500.00` |
| **customerInfo** | ✅ Yes | Customer details | See below |
| **customerInfo.customerName** | ✅ Yes | Customer's full name | `"John Doe"` |
| **customerInfo.customerEmail** | ✅ Yes | Valid email address | `"john@example.com"` |
| **customerInfo.customerPhone** | ❌ No | Customer phone number | `"+2348012345678"` |
| **customerInfo.customerAddress** | ❌ No | Delivery address | `"123 Main St"` |
| **notes** | ❌ No | Special instructions | `"Handle with care"` |
| **currency** | ❌ No | Currency code (default: "NGN") | `"NGN"` or `"USD"` |

### Important Notes

- **Total Amount**: Calculated automatically from items (quantity × price)
- **Order Number**: Generated automatically by Connect Fulfillment
- **QR Ticket**: Generated automatically and sent to customer via email
- **Order Status**: Starts as "pending" and updates as you process the order

---

## What You'll Receive

### Success Response (201 Created)

```json
{
  "message": "Order created successfully",
  "order": {
    "id": "507f1f77bcf86cd799439011",
    "orderNumber": "ORD-2025-123456789",
    "companyId": "507f1f77bcf86cd799439012",
    "companyName": "Your Company Name",
    "items": [
      {
        "productId": "prod_123",
        "productName": "Product Name",
        "quantity": 2,
        "price": 1500.00,
        "subtotal": 3000.00
      }
    ],
    "customerInfo": {
      "customerName": "John Doe",
      "customerEmail": "john@example.com",
      "customerPhone": "+2348012345678",
      "customerAddress": "123 Main St, Lagos"
    },
    "ticketId": null,
    "status": "pending",
    "totalAmount": 3000.00,
    "currency": "NGN",
    "notes": "Special delivery instructions",
    "createdAt": "2025-01-07T12:00:00.000Z",
    "updatedAt": "2025-01-07T12:00:00.000Z"
  }
}
```

### Response Fields Explained

| Field | Description | What to Do |
|-------|-------------|------------|
| **order.id** | Unique order ID | Store this for future reference |
| **order.orderNumber** | Human-readable order number | Display to customer |
| **order.status** | Current order status | Track order progress |
| **order.totalAmount** | Total order amount | Verify matches your payment |
| **order.ticketId** | QR ticket ID (null initially) | Will be set when order is packed |

### What Happens Next?

1. **Customer receives email** automatically with:
   - Order confirmation
   - QR ticket for pickup
   - Order details

2. **Order appears in your dashboard** with status "pending"

3. **You can update order status** as you process it:
   - `pending` → `processing` → `packed` → `completed`

4. **QR ticket is generated** when order status changes to "packed"

---

## Code Examples

### JavaScript (Node.js / Frontend)

```javascript
async function createFulfillmentOrder(orderData) {
  const API_KEY = 'YOUR_API_KEY_HERE';
  const API_URL = 'https://api.fulfillmate.com/order';

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'your_company_api_key': API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: orderData.items,
        customerInfo: {
          customerName: orderData.customerName,
          customerEmail: orderData.customerEmail,
          customerPhone: orderData.customerPhone,
          customerAddress: orderData.customerAddress
        },
        notes: orderData.notes || '',
        currency: orderData.currency || 'NGN'
      })
    });

    const result = await response.json();

    if (response.ok) {
      console.log('Order created:', result.order.orderNumber);
      return result;
    } else {
      console.error('Error:', result.message);
      throw new Error(result.message);
    }
  } catch (error) {
    console.error('Failed to create order:', error);
    throw error;
  }
}

// Usage after payment is successful
async function handleCheckout(cartItems, customer, paymentResult) {
  if (paymentResult.success) {
    const orderData = {
      items: cartItems.map(item => ({
        productId: item.id,
        productName: item.name,
        quantity: item.quantity,
        price: item.price
      })),
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      customerAddress: customer.address,
      currency: 'NGN'
    };

    try {
      const fulfillmentOrder = await createFulfillmentOrder(orderData);
      // Show success message to customer
      alert(`Order ${fulfillmentOrder.order.orderNumber} created successfully!`);
    } catch (error) {
      // Handle error - maybe retry or notify admin
      console.error('Fulfillment failed:', error);
    }
  }
}
```

### PHP

```php
<?php
function createFulfillmentOrder($orderData) {
    $apiKey = 'YOUR_API_KEY_HERE';
    $apiUrl = 'https://api.fulfillmate.com/order';

    $data = [
        'items' => $orderData['items'],
        'customerInfo' => [
            'customerName' => $orderData['customerName'],
            'customerEmail' => $orderData['customerEmail'],
            'customerPhone' => $orderData['customerPhone'] ?? '',
            'customerAddress' => $orderData['customerAddress'] ?? ''
        ],
        'notes' => $orderData['notes'] ?? '',
        'currency' => $orderData['currency'] ?? 'NGN'
    ];

    $ch = curl_init($apiUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'your_company_api_key: ' . $apiKey,
        'Content-Type: application/json'
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode === 201) {
        return json_decode($response, true);
    } else {
        $error = json_decode($response, true);
        throw new Exception($error['message'] ?? 'Failed to create order');
    }
}

// Usage after payment is successful
if ($paymentSuccessful) {
    $orderData = [
        'items' => [
            [
                'productId' => 'prod_123',
                'productName' => 'Product Name',
                'quantity' => 2,
                'price' => 1500.00
            ]
        ],
        'customerName' => 'John Doe',
        'customerEmail' => 'john@example.com',
        'customerPhone' => '+2348012345678',
        'customerAddress' => '123 Main St, Lagos',
        'currency' => 'NGN'
    ];

    try {
        $result = createFulfillmentOrder($orderData);
        echo "Order created: " . $result['order']['orderNumber'];
    } catch (Exception $e) {
        echo "Error: " . $e->getMessage();
    }
}
?>
```

### Python

```python
import requests
import json

def create_fulfillment_order(order_data):
    api_key = 'YOUR_API_KEY_HERE'
    api_url = 'https://api.fulfillmate.com/order'
    
    headers = {
        'your_company_api_key': api_key,
        'Content-Type': 'application/json'
    }
    
    payload = {
        'items': order_data['items'],
        'customerInfo': {
            'customerName': order_data['customerName'],
            'customerEmail': order_data['customerEmail'],
            'customerPhone': order_data.get('customerPhone', ''),
            'customerAddress': order_data.get('customerAddress', '')
        },
        'notes': order_data.get('notes', ''),
        'currency': order_data.get('currency', 'NGN')
    }
    
    response = requests.post(api_url, headers=headers, json=payload)
    
    if response.status_code == 201:
        return response.json()
    else:
        error = response.json()
        raise Exception(error.get('message', 'Failed to create order'))

# Usage after payment is successful
if payment_successful:
    order_data = {
        'items': [
            {
                'productId': 'prod_123',
                'productName': 'Product Name',
                'quantity': 2,
                'price': 1500.00
            }
        ],
        'customerName': 'John Doe',
        'customerEmail': 'john@example.com',
        'customerPhone': '+2348012345678',
        'customerAddress': '123 Main St, Lagos',
        'currency': 'NGN'
    }
    
    try:
        result = create_fulfillment_order(order_data)
        print(f"Order created: {result['order']['orderNumber']}")
    except Exception as e:
        print(f"Error: {e}")
```

### cURL (for testing)

```bash
curl -X POST https://api.fulfillmate.com/order \
  -H "your_company_api_key: YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {
        "productId": "prod_123",
        "productName": "Product Name",
        "quantity": 2,
        "price": 1500.00
      }
    ],
    "customerInfo": {
      "customerName": "John Doe",
      "customerEmail": "john@example.com",
      "customerPhone": "+2348012345678",
      "customerAddress": "123 Main St, Lagos"
    },
    "notes": "Special instructions",
    "currency": "NGN"
  }'
```

---

## Error Handling

### Common Error Responses

#### 400 Bad Request - Validation Error
```json
{
  "message": "Validation error",
  "error": "Customer information (name and email) is required"
}
```
**Solution**: Check that all required fields are included and properly formatted.

#### 401 Unauthorized - Missing API Key
```json
{
  "message": "API key is required"
}
```
**Solution**: Ensure you're sending the `your_company_api_key` header.

#### 403 Forbidden - Invalid API Key
```json
{
  "message": "Invalid API key"
}
```
**Solution**: Verify your API key is correct and active.

#### 503 Service Unavailable - Service Inactive
```json
{
  "message": "Service unavailable",
  "error": "This merchant is currently not accepting orders"
}
```
**Solution**: Your service might be temporarily disabled. Check your dashboard or contact support.

### Best Practices

1. **Always handle errors gracefully** - Don't show technical errors to customers
2. **Retry failed requests** - Network issues can happen, implement retry logic
3. **Log errors** - Keep logs for debugging and monitoring
4. **Validate data before sending** - Check required fields before making API calls
5. **Store order IDs** - Save the Connect Fulfillment order ID for future reference

---

## Testing

### Test Your Integration

1. **Use test orders** with small amounts
2. **Verify email delivery** - Check that customers receive confirmation emails
3. **Test error scenarios** - Try invalid data to ensure error handling works
4. **Check order status** - Verify orders appear in your dashboard
5. **Test QR tickets** - Ensure QR codes are generated and scannable

### Test Data Example

```json
{
  "items": [
    {
      "productId": "test_prod_001",
      "productName": "Test Product",
      "quantity": 1,
      "price": 100.00
    }
  ],
  "customerInfo": {
    "customerName": "Test Customer",
    "customerEmail": "test@example.com"
  },
  "currency": "NGN"
}
```

---

## Quick Reference

### API Endpoint
```
POST https://api.fulfillmate.com/order
```

### Required Header
```
your_company_api_key: YOUR_API_KEY_HERE
```

### Minimum Required Data
```json
{
  "items": [
    {
      "productId": "string",
      "productName": "string",
      "quantity": 1,
      "price": 0.00
    }
  ],
  "customerInfo": {
    "customerName": "string",
    "customerEmail": "valid@email.com"
  }
}
```

### Success Response Code
```
201 Created
```

---

## Support

### Need Help?

- **Documentation**: Check the full API documentation for more details
- **Support Tickets**: Create a ticket in your dashboard
- **Email**: Contact your account manager
- **Status Page**: Check service status if experiencing issues

### Common Questions

**Q: Can I send multiple items in one order?**  
A: Yes! Just include multiple items in the `items` array.

**Q: What if payment fails after I create the order?**  
A: You can cancel the order via the API or dashboard. Always process payment first, then create the order.

**Q: How do I track order status?**  
A: Use the order ID or order number to query order status via the API or check your dashboard.

**Q: Can I customize the email sent to customers?**  
A: Contact support to discuss email template customization options.

---

## Next Steps

After integrating:

1. ✅ Test with a few orders
2. ✅ Monitor order statuses
3. ✅ Set up order status webhooks (optional)
4. ✅ Configure service availability schedule
5. ✅ Train your team on the dashboard

---

*Last Updated: January 2025*

