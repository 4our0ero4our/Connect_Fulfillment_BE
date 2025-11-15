# Full Stack Project Description - Connect Fulfillment

## Project Overview
**Connect Fulfillment** is a SaaS order fulfillment platform I'm currently developing that connects verified merchants with customers and manages end-to-end order fulfillment. The platform serves three primary user types: Connect Fulfillment administrators, merchant administrators, and end customers, each with distinct roles and access levels.

## Tech Stack

### Backend
- **Runtime & Framework**: Node.js with Express.js
- **Language**: TypeScript (strict type checking for type safety)
- **Database**: MongoDB with Mongoose ODM (multi-database architecture)
- **Message Queue**: Apache Kafka (event-driven architecture for inter-service communication)
- **Caching & Rate Limiting**: Redis
- **Containerization**: Docker & Docker Compose
- **Architecture**: Microservices (6 independent services)

### Frontend
- **Framework**: React/Next.js (as mentioned - landing page and admin dashboards)
- **Language**: TypeScript (consistent type safety across stack)

## Architecture & Services

The platform follows a microservices architecture with the following services:

1. **API Gateway** - Central entry point handling routing, authentication, rate limiting, and request proxying
2. **Auth Service** - Manages authentication for Connect Fulfillment admins and company admins
3. **Company Service** - Handles merchant onboarding, verification, and API key management
4. **Order Service** - Core order management with CRUD operations, status tracking, and automated deletion
5. **Ticket Service** - Generates QR codes for order pickup and validates tickets
6. **Notification Service** - Sends email notifications for order events

## Key Features Implemented

### 1. **Multi-Tenant Authentication & Authorization**
- JWT-based authentication for platform admins and company admins
- API key validation for merchant systems
- Role-based access control (RBAC) with three distinct user types:
  - Connect Fulfillment Admins (full platform access)
  - Company Admins (company-specific dashboard access)
  - Merchants (API key-based system integration)

### 2. **Event-Driven Architecture**
- Kafka integration for asynchronous communication between services
- Events: `order_created`, `order_status_updated`, `ticket_attached_to_order`, `order_deleted`
- Decoupled services enabling scalability and fault tolerance

### 3. **Order Management System**
- Complete CRUD operations with proper access control
- Order status lifecycle management (pending → processing → packed → completed)
- Soft deletion with status tracking for analytics
- Automated order deletion based on merchant-configurable settings
- Backend pagination and sorting for efficient data retrieval

### 4. **Security Implementations**
- API key validation with rate limiting (3 invalid attempts → 3-hour ban)
- JWT token verification with role-based middleware
- Password hashing with bcrypt/scrypt fallback
- Request validation and sanitization
- Company context verification (prevents cross-tenant data access)
- Secure header forwarding between services

### 5. **Scalability Features**
- Microservices architecture for independent scaling
- Redis caching for rate limiting and performance optimization
- Database indexing for optimized queries
- Docker containerization for easy deployment and scaling
- Horizontal scaling capability for each service

## My Role

I **singlehandedly architected and implemented** the entire backend infrastructure, including:
- Designed and implemented the microservices architecture
- Built all 6 backend services from scratch
- Implemented authentication and authorization systems
- Created comprehensive API documentation
- Set up Docker containerization and service orchestration
- Integrated Kafka for event-driven communication
- Implemented security middleware and rate limiting
- Developed the frontend landing page and admin dashboards (React/Next.js)

## Challenges Faced & Solutions

### 1. **Inter-Service Communication & Service Discovery**
**Challenge**: Services needed to communicate reliably, but Docker networking and local development environments caused connection issues.

**Solution**: Implemented a fallback mechanism for service URLs that attempts multiple endpoints (environment variables, Docker internal URLs, localhost). This ensures services can find each other whether running in Docker or locally, improving developer experience and deployment flexibility.

### 2. **Complex Authentication & Authorization**
**Challenge**: Implementing three different authentication methods (JWT for admins, JWT for company admins, API keys for merchants) while ensuring proper access control and preventing cross-tenant data access.

**Solution**: 
- Created modular middleware for each authentication type (`verifyCFAdmin`, `verifyCompanyAdmin`, `verifyMerchant`)
- Implemented a unified `verifyAdminOrMerchant` middleware that supports all three authentication methods
- Added company context validation to ensure merchants and company admins can only access their own company's data
- Implemented token payload validation to distinguish between different admin types

### 3. **Data Consistency Across Services**
**Challenge**: Ensuring data consistency when orders are created, updated, or deleted across multiple services (Order Service, Ticket Service, Notification Service).

**Solution**: Implemented event-driven architecture with Kafka. When an order status changes to "packed", the Order Service publishes an event that the Ticket Service consumes to generate a QR code. This decouples services while maintaining data consistency through events.

### 4. **Security & Rate Limiting**
**Challenge**: Protecting the platform from abuse while maintaining good user experience. Needed to implement rate limiting that doesn't block legitimate users but prevents API key brute force attacks.

**Solution**: 
- Implemented Redis-based rate limiting with different strategies:
  - General rate limiting for auth endpoints (5 requests per minute)
  - Invalid API key rate limiting (3 attempts → 3-hour ban per IP/route)
- Used Redis for fast lookup and distributed rate limiting across service instances
- Implemented IP-based tracking with route-specific buckets to prevent cross-route abuse

### 5. **Order Attribution & Multi-Tenancy**
**Challenge**: Ensuring orders are correctly attributed to companies and preventing merchants from accessing other companies' orders, even with valid API keys.

**Solution**: 
- Implemented secure company ID extraction from API key validation (never from request body)
- Added middleware that validates company context before allowing access
- Implemented `verifyOrderAccess` middleware that checks order ownership before allowing operations
- Used MongoDB indexes on `companyId` and `companyApiKey` for efficient filtering

### 6. **Type Safety & Error Handling**
**Challenge**: Maintaining type safety across microservices while handling errors gracefully and providing meaningful error messages.

**Solution**: 
- Enforced TypeScript strict mode across all services
- Created comprehensive interface definitions for all data models
- Implemented consistent error response formats
- Added validation middleware that provides detailed error messages
- Used Mongoose schemas with TypeScript interfaces for database models

### 7. **Automated Order Deletion**
**Challenge**: Implementing a scheduled job that automatically deletes orders based on merchant-configurable settings (days to delete, deletion time) while ensuring it only affects the correct company's orders.

**Solution**: 
- Created a scheduled job using Node.js cron that runs every hour
- Implemented company-specific deletion settings in the Company model
- Added validation to ensure only uncompleted orders are deleted
- Used MongoDB queries with companyId filtering to ensure data isolation
- Implemented soft deletion (status change) instead of hard deletion for data retention

## Technical Highlights

- **Type Safety**: Strict TypeScript enforcement across frontend and backend
- **Security**: Multi-layer authentication, authorization, and rate limiting
- **Scalability**: Microservices architecture with event-driven communication
- **Performance**: Redis caching, database indexing, backend pagination
- **Developer Experience**: Comprehensive API documentation, Docker containerization, fallback mechanisms for local development
- **Data Integrity**: Event-driven architecture, soft deletion, comprehensive validation

## Impact & Results

- Built a production-ready SaaS platform with 6 microservices
- Implemented robust security measures preventing unauthorized access
- Created a scalable architecture that can handle growth
- Developed comprehensive documentation for API integration
- Established patterns for future microservices development

This project demonstrates my ability to architect complex systems, implement security best practices, solve challenging technical problems, and deliver a production-ready SaaS platform. The microservices architecture, event-driven design, and comprehensive security implementation showcase my full-stack development skills and understanding of scalable system design.



