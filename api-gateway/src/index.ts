import express from 'express';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import { Request, Response } from 'express';

const app = express();

const authProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.AUTH_SERVICE_URL as string || 'http://auth-service:4001', 
  changeOrigin: true,
  pathRewrite: { '^/auth': '' }
});
const orderProxy: RequestHandler = createProxyMiddleware({ 
  target: process.env.ORDER_SERVICE_URL as string || 'http://order-service:4002', 
  changeOrigin: true,
  pathRewrite: { '^/order': '' }
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

app.get('/', (req: Request, res: Response) => {
  res.json({ 
    message: 'Hello World from the Connect Fulfillment API Gateway. Seeing this message means your API KEY is valid and the API Gateway is working correctly. Congratulations!',
    services: ['/auth', '/order', '/ticket', '/company', '/notify'],
    health: '/health',
    timestamp: new Date().toISOString(),
    service: 'api-gateway',
  });
});

app.use('/auth', authProxy);
app.use('/order', orderProxy);
app.use('/ticket', ticketProxy);
app.use('/company', companyProxy);
app.use('/notify', notificationProxy);
app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' , timestamp: new Date().toISOString(), service: 'api-gateway' }));

app.listen(process.env.API_GATEWAY_PORT as unknown as number || 4000, () => (console.log(`API Gateway listening on ${process.env.API_GATEWAY_PORT as unknown as number || 4000}`)));