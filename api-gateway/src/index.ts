import express, { NextFunction } from 'express';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import { Request, Response } from 'express';
import { validateApiKey } from './middleware/apiKeyValidator';
import { checkInvalidApiKeyBan } from './middleware/gatewayRateLimit';

const app = express();

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
    console.log(`[API Gateway] Proxying ${req.method} ${req.url} to auth-service`);
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
  onProxyRes: (proxyRes, req, res) => {
    console.log(`[API Gateway] Received response from auth-service: ${proxyRes.statusCode} for ${req.method} ${req.url}`);
  },
  logLevel: 'warn'
});
const orderProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.ORDER_SERVICE_URL as string || 'http://order-service:4002', 
  changeOrigin: true,
  pathRewrite: { '^/order': '' },
  onProxyReq: (proxyReq, req: any, res) => {
    console.log(`[API Gateway] Proxying ${req.method} ${req.url} to order-service`);
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
    console.log(`[API Gateway] Proxying ${req.method} ${req.url} to order-service`);
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
  pathRewrite: { '^/company': '' }
});
const notificationProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.NOTIFICATION_SERVICE_URL as string || 'http://notification-service:4005',   
  changeOrigin: true,
  pathRewrite: { '^/notify': '' }
});

// ✅ Working perfectly
// Root endpoint (to confirm API key is valid)
app.get('/', checkInvalidApiKeyBan( 'api-gateway' ), validateApiKey, (_req: Request, res: Response) => {
  res.json({ 
    message: `Hello ${res.locals.company?.companyName}. Congratulations on successfully integrating your API with the Connect Fulfillment API Gateway. Seeing this message means your API KEY is valid and the API Gateway is working correctly.`,
    companyDetails: res.locals.company ? res.locals.company : 'No company details found',
    services: [{ name: 'auth', url: '/auth', description: 'Authentication Service' }, { name: 'order', url: '/order', description: 'Order Service' }, { name: 'ticket', url: '/ticket', description: 'Ticket Service' }, { name: 'company', url: '/company', description: 'Company Service' }, { name: 'notify', url: '/notify', description: 'Notification Service' }],
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

// Services routes that are protected by validateApiKey middleware (API key validation)
// Route /orders (plural) for getting/managing orders - must come AFTER customer route to avoid conflicts
app.use('/orders', checkInvalidApiKeyBan( 'order' ), validateApiKey, ordersProxy);
// Route /order (singular) for creating orders
app.use('/order', checkInvalidApiKeyBan( 'order' ), validateApiKey, orderProxy);
app.use('/ticket', checkInvalidApiKeyBan( 'ticket' ), validateApiKey, ticketProxy);
app.use('/company', checkInvalidApiKeyBan( 'company' ), validateApiKey, companyProxy);
app.use('/notify', checkInvalidApiKeyBan( 'notify' ), validateApiKey, notificationProxy);

app.listen(process.env.API_GATEWAY_PORT as unknown as number || 4000, () => (console.log(`API Gateway listening on ${process.env.API_GATEWAY_PORT as unknown as number || 4000}`)));