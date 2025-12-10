import express from 'express';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { validateApiKey } from './middleware/apiKeyValidator';
import { checkInvalidApiKeyBan, detectAnomalies } from './middleware/gatewayRateLimit';

const app = express();

// Parse cookies for auth token extraction
app.use(cookieParser());

// Body parsing middleware (needed for DELETE requests with bodies)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Timeout middleware
app.use((req, res, next) => {
  req.setTimeout(30000); 
  res.setTimeout(30000); 
  next();
});

// ✅ Working perfectly
// Auth service proxy
const authProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.AUTH_SERVICE_URL as string || 'http://auth-service:4001', 
  changeOrigin: true,
  pathRewrite: { '^/auth': '' },
  timeout: 30000, // timeout
  proxyTimeout: 30000, // proxy timeout
  onError: (err, _req, res) => {
    console.error('Auth service proxy error:', err.message);
    res.status(503).json({ 
      error: 'Auth service unavailable', 
      message: 'Unable to connect to authentication service. Please check if the service is running.',
      details: err.message 
    });
  },
  onProxyReq: (proxyReq, req: any, res) => {
    // If body was parsed by any middleware, re-stream it to the target
    // DELETE requests can also have bodies (though not common, some APIs use them)
    if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) {
      const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!proxyReq.getHeader('Content-Type')) {
        proxyReq.setHeader('Content-Type', 'application/json');
      }
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
      proxyReq.end();
    }
  },
  logLevel: 'warn'
});
const orderProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.ORDER_SERVICE_URL as string || 'http://order-service:4002', 
  changeOrigin: true,
  pathRewrite: { '^/order': '' },
  onProxyReq: (proxyReq, req: any, res) => {
    // Forward verified company headers when available
    if (req.headers['x-company-id']) {
      proxyReq.setHeader('x-company-id', req.headers['x-company-id']);
    }
    if (req.headers['x-company-api-key']) {
      proxyReq.setHeader('x-company-api-key', req.headers['x-company-api-key']);
    }
    if (req.headers['x-company-name']) {
      proxyReq.setHeader('x-company-name', req.headers['x-company-name']);
    }
    if (req.headers['x-company-email']) {
      proxyReq.setHeader('x-company-email', req.headers['x-company-email']);
    }

    // If body was parsed by any middleware, re-stream it to the target
    if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) {
      const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!proxyReq.getHeader('Content-Type')) {
        proxyReq.setHeader('Content-Type', 'application/json');
      }
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
      proxyReq.end();
    }
  },
});

// Proxy for /orders routes (plural) - routes directly to order-service without stripping prefix
const ordersProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.ORDER_SERVICE_URL as string || 'http://order-service:4002', 
  changeOrigin: true,
  // Don't rewrite path - keep /orders as is
  onProxyReq: (proxyReq, req: any, res) => {
    if (req.headers['x-company-id']) {
      proxyReq.setHeader('x-company-id', req.headers['x-company-id']);
    }
    if (req.headers['x-company-api-key']) {
      proxyReq.setHeader('x-company-api-key', req.headers['x-company-api-key']);
    }
    if (req.headers['x-company-name']) {
      proxyReq.setHeader('x-company-name', req.headers['x-company-name']);
    }
    if (req.headers['x-company-email']) {
      proxyReq.setHeader('x-company-email', req.headers['x-company-email']);
    }

    // If body was parsed by any middleware, re-stream it to the target
    if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) {
      const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!proxyReq.getHeader('Content-Type')) {
        proxyReq.setHeader('Content-Type', 'application/json');
      }
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
      proxyReq.end();
    }
  },
});
const ticketProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.TICKET_SERVICE_URL as string || 'http://ticket-service:4003', 
  changeOrigin: true,
  pathRewrite: { '^/ticket': '' }
});
const companyProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.COMPANY_SERVICE_URL as string || 'http://company-service:4004', 
  changeOrigin: true,
  pathRewrite: { '^/company': '' },
  timeout: 60000, // 60 seconds timeout
  proxyTimeout: 60000, // 60 seconds proxy timeout
  onError: (err, _req, res) => {
    console.error('Company service proxy error:', err.message);
    if (!res.headersSent) {
      res.status(503).json({ 
        error: 'Company service unavailable', 
        message: 'Unable to connect to company service. Please check if the service is running.',
        details: err.message 
      });
    }
  },
  onProxyReq: (proxyReq, req: any, res) => {
    // Forward headers that might be needed by company service
    if (req.headers['your_company_api_key']) {
      proxyReq.setHeader('your_company_api_key', req.headers['your_company_api_key']);
    }
    if (req.headers['company_to_add_admin_email_to']) {
      proxyReq.setHeader('company_to_add_admin_email_to', req.headers['company_to_add_admin_email_to']);
    }
    // Forward authorization header for CF admin tokens
    if (req.headers['authorization']) {
      proxyReq.setHeader('authorization', req.headers['authorization']);
    }
    // If body was parsed by any middleware, re-stream it to the target
    if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) {
      const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!proxyReq.getHeader('Content-Type')) {
        proxyReq.setHeader('Content-Type', 'application/json');
      }
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
      proxyReq.end();
    }
  },
  logLevel: 'warn'
});
const notificationProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.NOTIFICATION_SERVICE_URL as string || 'http://notification-service:4005',   
  changeOrigin: true,
  pathRewrite: { '^/notify': '' }
});
const messagingProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.MESSAGING_SERVICE_URL as string || 'http://messaging-service:4006', 
  changeOrigin: true,
  pathRewrite: { '^/messaging': '' },
  onProxyReq: (proxyReq, req: any, res) => {
    // Forward authorization header
    if (req.headers['authorization']) {
      proxyReq.setHeader('authorization', req.headers['authorization']);
    }
    // Forward company API key if present
    if (req.headers['your_company_api_key']) {
      proxyReq.setHeader('your_company_api_key', req.headers['your_company_api_key']);
    }
    // If body was parsed, re-stream it
    if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) {
      const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!proxyReq.getHeader('Content-Type')) {
        proxyReq.setHeader('Content-Type', 'application/json');
      }
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
      proxyReq.end();
    }
  },
});

// ✅ Working perfectly
// Root endpoint (to confirm API key is valid)
app.get('/', checkInvalidApiKeyBan( 'api-gateway' ), validateApiKey, (_req: Request, res: Response) => {
  res.json({ 
    message: `Hello ${res.locals.company?.companyName}. Congratulations on successfully integrating your API with the Connect Fulfillment API Gateway. Seeing this message means your API KEY is valid and the API Gateway is working correctly.`,
    companyDetails: res.locals.company ? res.locals.company : 'No company details found',
    services: [{ name: 'auth', url: '/auth', description: 'Authentication Service' }, { name: 'order', url: '/order', description: 'Order Service' }, { name: 'ticket', url: '/ticket', description: 'Ticket Service' }, { name: 'company', url: '/company', description: 'Company Service' }, { name: 'notify', url: '/notify', description: 'Notification Service' }, { name: 'messaging', url: '/messaging', description: 'Messaging/Support Service' }],
    health: '/health',
    timestamp: new Date().toISOString(),
    service: 'api-gateway',
  });
});

// ✅ Working perfectly
// Root health check endpoint (no API key required)
app.get('/health', (_req: Request, res: Response) => res.json({ status:'ok' , timestamp: new Date().toISOString(), service: 'api-gateway' }));

// ✅ Working perfectly
// Auth service route (no API key required)
app.use('/auth', authProxy);

// Public customer order route (no API key required) - must come BEFORE /orders to avoid conflicts
// POST /orders/customer - Customers can get their orders in their mail by providing their email (email in body)
app.post('/orders/customer', ordersProxy);

// Public company routes (no API key required) - must come BEFORE protected /company route to avoid conflicts
// These routes validate the API key internally, so they don't need gateway validation
app.post('/company/register', companyProxy);
app.post('/company/company-admin/register', companyProxy);
app.post('/company/company-admin/login', companyProxy);
app.post('/company/company-admin/refresh-token', companyProxy);
app.post('/company/company-admin/logout', companyProxy);
app.get('/company/company-admin/verify-token', companyProxy);
app.get('/company/verify-key', companyProxy);

// CF Admin routes (protected by verifyCFAdminToken in service, no API key required)
// These routes only require CF Admin JWT token, not company API key
app.get('/company/companies', companyProxy);
app.post('/company/add-admin-email-to-company', companyProxy);

// Messaging/Support routes (protected by JWT tokens in service, no API key required for CF Admin)
// Company Admin routes require company API key or JWT token
app.get('/messaging/tickets/log', messagingProxy); // CF Admin only - ticket log
app.use('/messaging', checkInvalidApiKeyBan('messaging'), detectAnomalies, validateApiKey, messagingProxy);

// Services routes that are protected by validateApiKey middleware (API key validation)
// Anomaly detection runs before validation to detect suspicious patterns without blocking normal high-volume usage
// Route /orders (plural) for getting/managing orders - must come AFTER customer route to avoid conflicts
app.use('/orders', checkInvalidApiKeyBan( 'order' ), detectAnomalies, validateApiKey, ordersProxy);
// Route /order (singular) for creating orders
app.use('/order', checkInvalidApiKeyBan( 'order' ), detectAnomalies, validateApiKey, orderProxy);
// Route /logs for audit logs - accessible via order service
app.use('/logs', checkInvalidApiKeyBan( 'order' ), detectAnomalies, validateApiKey, ordersProxy);
app.use('/ticket', checkInvalidApiKeyBan( 'ticket' ), detectAnomalies, validateApiKey, ticketProxy);
// Protected company routes (API key required) - must come AFTER public routes to avoid conflicts
app.use('/company', checkInvalidApiKeyBan( 'company' ), detectAnomalies, validateApiKey, companyProxy);
app.use('/notify', checkInvalidApiKeyBan( 'notify' ), detectAnomalies, validateApiKey, notificationProxy);

app.listen(process.env.API_GATEWAY_PORT as unknown as number || 4000, () => (console.log(`API Gateway listening on ${process.env.API_GATEWAY_PORT as unknown as number || 4000}`)));