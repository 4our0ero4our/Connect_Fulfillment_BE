# FulfillMate - Backend API (For any dev that has the chance to view this, lol)

A multi-tenant B2B fulfillment platform backend built with microservices architecture.

## 🏗️ Architecture

- **API Gateway** - Single entry point with API key validation
- **Auth Service** - CF Admin authentication and staff management
- **Company Service** - Merchant onboarding and company admin auth
- **Order Service** - Order lifecycle management
- **Ticket Service** - QR ticket generation and validation
- **Notification Service** - Email dispatch via SMTP

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- MongoDB (Atlas or local)
- Redis (included in Docker Compose)
- Kafka (included in Docker Compose)

### Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd Connect-Fulfillment-BE
   ```

2. **Create environment file**
   ```bash
   cp .env.example .env
   ```

3. **Configure environment variables**
   Edit `.env` and update:
   - MongoDB connection strings
   - JWT_SECRET (use a strong random value)
   - SMTP credentials (for email delivery)
   - Other service URLs

4. **Start all services**
   ```bash
   docker compose up --build
   ```

5. **Verify services are running**
   ```bash
   curl http://localhost:4000/health
   ```

## 📡 API Gateway

All external requests go through the API Gateway at `http://localhost:4000`

### Authentication

- **CF Admin**: Use JWT token from `/auth/login` in `Authorization: Bearer <token>` header
- **Merchant**: Use company API key in `your_company_api_key` header

### Available Routes

See [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) for complete API documentation, I'm the only one that have this, be informed!.

## 🔧 Development

### View logs
```bash
docker compose logs -f <service-name>
```

### Restart a service
```bash
docker compose restart <service-name>
```

### Stop all services
```bash
docker compose down
```

## 📦 Services

| Service | Port | Database |
|---------|------|----------|
| API Gateway | 4000 | - |
| Auth Service | 4001 | AdminDB |
| Order Service | 4002 | OrderDB |
| Ticket Service | 4003 | TicketDB |
| Company Service | 4004 | CompanyDB |
| Notification Service | 4005 | - |

## 🔐 Security

- API keys validated via Company Service
- JWT tokens for admin authentication
- Rate limiting on auth endpoints
- Anomaly detection for suspicious patterns
- Internal service tokens for inter-service communication

## 📧 Email Configuration

Configure SMTP settings in `.env` file. See [SMTP_CONFIGURATION_GUIDE.md](./SMTP_CONFIGURATION_GUIDE.md) for detailed setup instructions, I'm the only one that have this too, be informed!.

## 🧪 Testing

Test the API using the provided Postman collection or curl commands.

## 📚 Documentation (I'm the only one that have these, be informed)

- [API Documentation](./API_DOCUMENTATION.md)
- [SMTP Configuration Guide](./SMTP_CONFIGURATION_GUIDE.md)
- [Implementation Summary](./IMPLEMENTATION_SUMMARY.md)

## 🎯 Next Steps

1. Configure SMTP for email delivery
2. Set up production MongoDB
3. Deploy to production environment
4. Build frontend dashboards (CF Admin & Merchant Admin)
5. Build customer-facing mobile app

## 📝 License

[Omoh! Nothing to see here for now sha]
