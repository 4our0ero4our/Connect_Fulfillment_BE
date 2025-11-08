# 🚀 Connect Fulfillment MVP's 14-Day Build & Learn Plan

**Stack:** TypeScript, Node.js (Express), Next.js (frontend), MongoDB, Kafka, Redis, Docker, Docker Compose, JWT/Magic Links  
**Services:** API Gateway, Auth Service, Company Service, Order Service, Ticket Service, Notification Service  
**Goal:** Ship a working backend MVP supporting merchant onboarding, order → ticket generation, email delivery, and scan-to-validate flow. Includes Docker + Kafka + Redis from day 1.

---

## What Will Be Built

- Local multi-container environment (Kafka, Zookeeper, Redis, MongoDB) via `docker compose`.
- Microservices (Auth, Company, Order, Ticket, Notification) each in its own container.
- API Gateway routing requests.
- Order → Ticket event flow via Kafka; Notification sends emails.
- Scan endpoint to validate tickets (fast, low-latency path).

---

## Table of Contents

- [Architecture (Expanded HLD)](#architecture-expanded-hld)
- [Repo & File Structure](#repo--file-structure)
- [Essential Commands & Workflow](#essential-commands--workflow)
- [Docker Compose (example)](#docker-compose-example)
- [Kafka Notes & Local Setup](#kafka-notes--local-setup)
- [Redis Usage Patterns](#redis-usage-patterns)
- [14-Day Roadmap (Daily Checklist)](#14-day-roadmap-daily-checklist)
- [Testing, Postman, and Deployment Tips](#testing-postman-and-deployment-tips)
- [Next Steps & Scaling](#next-steps--scaling)

---

## Architecture (Expanded HLD)

This is a more detailed architecture diagram showing services, data flow, and responsibilities.

```
                                +---------------------------+
                                |        Load Balancer      |
                                |   (nginx / cloud LB)      |
                                +-----------+---------------+
                                            |
                                   +--------v--------+
                                   |    API Gateway   |
                                   | - TLS termination|
                                   | - Auth checks    |
                                   | - Rate limiting  |
                                   +---+---+---+---+--+
                +----------------------+   |   |   |      +----------------+
                |                      |   |   |   |      |                |
                v                      v   v   v   v      v                v
         +-----------+           +---------+ +--------+ +--------+  +-----------+
         | Auth MS   | <-------> | Company | | Order  | | Ticket |  | Notification|
         | (JWT,API) |           | Service | | Service| | Service|  | Service     |
         +-----------+           +---------+ +--------+ +--------+  +-----------+
             |  ^                    |           |         |           |
             |  |                    |           |         |           |
             |  +---- (read/write) --+           |         |           |
             |         MongoDB                    |         |           |
             |                                      |         |           |
             |                                      |         |           |
             |                                      v         v           |
             |                                  Kafka Broker <--+        |
             |                                  (topics:        |        |
             |                                   orders,        |        |
             +---------------------------------> tickets,        |        |
                                                notifications)  |        |
                                                                |        |
                                                             Redis (cache,|
                                                             sessions,     |
                                                             rate-limit)   |
```

**Key flows**

- **Merchant onboarding**: Merchant uses API Gateway → Company Service → Company DB. Company verification (CAC/doc upload) may be manual or via external API; results cached in Redis.
- **Order creation**:
  1. Merchant calls `POST /order` (gateway checks API key).
  2. Order Service writes order → emits `order.created` to Kafka.
  3. Ticket Service consumes `order.created`, generates ticket, QR payload, stores ticket in its DB, emits `ticket.generated`.
  4. Notification Service consumes `ticket.generated` and sends email (or webhook) to customer.
- **Ticket validation (scan)**: Store staff calls `POST /ticket/validate` with QR/token → Gateway routes to Ticket Service → Ticket Service checks Redis cache for quick validation, then falls back to MongoDB and marks ticket as used (idempotent).

---

## Repo & File Structure (Monorepo suggested)

```
/connect-fulfillment/
├── docker-compose.yml
├── .env
├── README.md
├── api-gateway/
│   ├── Dockerfile
│   ├── src/
│   │   └── index.ts
│   └── package.json
├── services/
│   ├── auth-service/
│   │   ├── Dockerfile
│   │   ├── src/
│   │   │   ├── controllers/
│   │   │   ├── routes/
│   │   │   ├── models/
│   │   │   └── index.ts
│   │   └── package.json
│   ├── company-service/
│   ├── order-service/
│   ├── ticket-service/
│   └── notification-service/
├── infra/
│   ├── kafka/
│   └── scripts/
└── docs/
    └── architecture.md
```

---

## Essential Commands & Workflow

**Docker / Compose**

```bash
# Build images (first time)
docker compose build

# Start all containers (detached)
docker compose up -d

# View logs (all)
docker compose logs -f

# View logs (single service)
docker compose logs -f ticket-service

# Stop and remove containers
docker compose down
```

**Node / TypeScript**

```bash
# inside a service folder
pnpm install
pnpm run build
pnpm run start:dev   # nodemon / ts-node-dev
```

**Kafka (if you need to use CLI inside container)**

```bash
# list topics (example, container name kafka)
docker exec -it kafka kafka-topics --bootstrap-server kafka:9092 --list
```

---

## Docker Compose (example)

Use this as a starting point. Save as `docker-compose.yml` in repo root.

> NOTE: This is a minimal, dev-ready setup. In production, use managed Kafka or secure configs.

```yaml
version: "3.8"
services:
  zookeeper:
    image: confluentinc/cp-zookeeper:7.4.0
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000
    ports:
      - "2181:2181"

  kafka:
    image: confluentinc/cp-kafka:7.4.0
    depends_on:
      - zookeeper
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: "zookeeper:2181"
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    ports:
      - "9092:9092"

  mongodb:
    image: mongo:6.0
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db

  redis:
    image: redis:7
    ports:
      - "6379:6379"

  api-gateway:
    build: ./api-gateway
    ports:
      - "4000:4000"
    depends_on:
      - auth-service
      - order-service
      - ticket-service
    environment:
      - NODE_ENV=development

  auth-service:
    build: ./services/auth-service
    ports:
      - "4001:4001"
    environment:
      - MONGO_URI=mongodb://mongodb:27017/auth
      - REDIS_URL=redis://redis:6379
      - KAFKA_BROKERS=kafka:9092
    depends_on:
      - mongodb
      - redis
      - kafka

  order-service:
    build: ./services/order-service
    ports:
      - "4002:4002"
    environment:
      - MONGO_URI=mongodb://mongodb:27017/orders
      - KAFKA_BROKERS=kafka:9092
      - REDIS_URL=redis://redis:6379
    depends_on:
      - mongodb
      - kafka
      - redis

  ticket-service:
    build: ./services/ticket-service
    ports:
      - "4003:4003"
    environment:
      - MONGO_URI=mongodb://mongodb:27017/tickets
      - KAFKA_BROKERS=kafka:9092
      - REDIS_URL=redis://redis:6379
    depends_on:
      - mongodb
      - kafka
      - redis

  notification-service:
    build: ./services/notification-service
    ports:
      - "4004:4004"
    environment:
      - SMTP_HOST=smtp.example.com
      - SMTP_USER=...
    depends_on:
      - kafka

volumes:
  mongo-data:
```

---

## Kafka Notes & Local Setup

- Use the `confluentinc` images above for dev. They include Kafka CLI tools.
- Topics you'll create:
  - `order.created`
  - `ticket.generated`
  - `notification.sent` (optional)
- Create topics once containers are up:

```bash
docker exec -it kafka kafka-topics --create --topic order.created --bootstrap-server kafka:9092 --partitions 3 --replication-factor 1
docker exec -it kafka kafka-topics --create --topic ticket.generated --bootstrap-server kafka:9092 --partitions 3 --replication-factor 1
```

- Use a Node Kafka client like `kafkajs` or `node-rdkafka`. `kafkajs` is simpler for TypeScript.

**kafkajs example (producer):**

```ts
import { Kafka } from "kafkajs";
const kafka = new Kafka({ brokers: [process.env.KAFKA_BROKERS!] });
const producer = kafka.producer();
await producer.connect();
await producer.send({
  topic: "order.created",
  messages: [{ key: orderId, value: JSON.stringify(orderPayload) }],
});
```

**kafkajs example (consumer):**

```ts
const consumer = kafka.consumer({ groupId: "ticket-service-group" });
await consumer.connect();
await consumer.subscribe({ topic: "order.created", fromBeginning: false });
await consumer.run({
  eachMessage: async ({ topic, partition, message }) => {
    const order = JSON.parse(message.value!.toString());
    // generate ticket...
  },
});
```

---

## Redis Usage Patterns

- **Cache**: store `companyVerification:companyId -> verificationResult` with TTL.
- **Token blacklist**: `blacklist:tokenHash -> true` with expiry same as token.
- **Rate limiting**: use Redis INCR with expiry (sliding window).
- **Fast ticket lookup**: cache `ticket:ticketCode -> {orderId, used, expiresAt}` for a short TTL (e.g., 15 minutes) so scanning is near-instant.

**Redis Node example (node-redis):**

```ts
import { createClient } from "redis";
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
await redis.set(`ticket:${code}`, JSON.stringify(ticket), { EX: 900 });
const cached = await redis.get(`ticket:${code}`);
```

Redis docs: https://redis.io/docs/latest/

---

## 14-Day Roadmap (Hackathon pace) — Daily Checklist

> Tips: Work in 4–6 hour sprints per day. Aim to push a commit and run the full `docker compose up -d` by end of every 2 days.

### Day 0 — Prep (Pre-start)

- [✅] Create repo, `.gitignore`, `.env.example`, README
- [✅] Setup monorepo skeleton (folders per services)
- [✅] Install Docker & Docker Compose locally
- [✅] Install Node & pnpm/npm

---

### Day 1 — Local infra + basic services

**Learning:** Docker basics, containers vs VMs, docker-compose structure.  
**Build:**

- [✅] Create `docker-compose.yml` (use example above)
- [✅] Add MongoDB, Redis, Kafka, Zookeeper services
- [✅] Start infra: `docker compose up -d`
- [✅] Verify `mongo`, `redis`, `kafka` reachable

**Deliverable:** infra up and running

---

### Day 2 — API Gateway + Auth service skeleton

**Learning:** API Gateway pattern, express reverse proxy basics.  
**Build:**

- [✅] Scaffold API Gateway (Express + http-proxy-middleware)
- [✅] Scaffold Auth service (TS, Express)
- [✅] Connect Auth service to MongoDB
- [✅] Auth endpoints: `POST /auth/register`, `POST /auth/login` (stubs)

**Deliverable:** Gateway routes to Auth; basic register/login flow (no JWT yet)

---

### Day 3 — JWT, API keys, Redis for sessions

**Learning:** JWT, API keys, Redis sessions/cache.  
**Build:**

- [✅] Implement JWT-based login in Auth (issue JWT, refresh token)
- [✅] Add API key generation for companies (store hashed apiKey in Company collection - Will be done on the admin dashboards now)
- [✅] Use Redis for session or token blacklist
- [✅] Gateway validates JWT/API key

**Milestone (Day 3):** Merchant can register and receive API key; gateway validates API key.

---

### Day 4 — Company Service + verification flow

**Learning:** File uploads (docs), secure storage (S3 / local for dev).  
**Build:**

- [✅] Scaffold Company Service (endpoints: POST /company, GET /company/:id)
- [✅] Add doc upload endpoint (dev: save in `/tmp` or local `infra/uploads`)

**Deliverable:** Company onboarding flow

---

### Day 5 — Order Service skeleton + DB model

**Learning:** Designing order schema, idempotency, request validation.  
**Build:**

- [ ] Scaffold Order Service with Mongoose models
- [ ] Implement `POST /order` (validate API key via gateway/auth)
- [ ] Implement idempotency key header handling

**Deliverable:** Orders can be created and stored

---

### Day 6 — Kafka producer (Order Service) + topic creation

**Learning:** Kafka producers, topics, kafkajs.  
**Build:**

- [ ] Add `kafkajs` to Order Service
- [ ] Create `order.created` topic (see CLI commands)
- [ ] Emit `order.created` on successful order creation

**Deliverable:** Orders produce events to Kafka

---

### Day 7 — Ticket Service consumer + ticket model

**Learning:** Kafka consumers, idempotent consumers, QR code basics.  
**Build:**

- [ ] Scaffold Ticket Service
- [ ] Consumer subscribes to `order.created`, generates ticket (secure random token), stores ticket in MongoDB
- [ ] Generate QR payload (e.g., URL with retrieval token) and save `ticketCache` in Redis
- [ ] Produce `ticket.generated` to Kafka

**Milestone (Day 7):** Event-driven order→ticket generation complete

---

### Day 8 — Notification Service (email) + magic link

**Learning:** Email delivery (SendGrid / NodeMailer), templating.  
**Build:**

- [ ] Scaffold Notification Service
- [ ] Consume `ticket.generated`, send email with magic retrieval link and QR image (dataURI)
- [ ] Store delivery status

**Deliverable:** Customer receives ticket email

---

### Day 9 — Merchant Dashboard endpoints + Webhook (basic)

**Learning:** Webhooks, webhook signing, CORS.  
**Build:**

- [ ] Add endpoints in Company or API Gateway for merchant dashboard retrieval of orders/tickets
- [ ] Implement simple websocket or polling endpoint for real-time updates (dev: polling ok)
- [ ] Implement webhook delivery for merchants who want callbacks

**Deliverable:** Merchant can fetch orders and ticket statuses

---

### Day 10 — Ticket validation endpoint (scan) — make it fast

**Learning:** Low-latency design, caching with Redis.  
**Build:**

- [ ] Implement `POST /ticket/validate` in Ticket Service
- [ ] First check Redis for `ticket:code`; if not found, query MongoDB, then cache result
- [ ] Mark ticket as used (atomic operation) and notify Order Service or emit `ticket.collected`

**Milestone (Day 10):** Scan-to-validate working (fast path via Redis)

---

### Day 11 — Idempotency, retries, error handling

**Learning:** Circuit breakers, retries, exponential backoff.  
**Build:**

- [ ] Add retry logic to Notification Service (for email failures) with backoff and DLQ (Redis list or Kafka topic)
- [ ] Add idempotency store (Redis table / collection) for order creation and ticket validation
- [ ] Improve error responses and logging

**Deliverable:** Robustness improvements

---

### Day 12 — Observability: Logging, metrics, tracing

**Learning:** OpenTelemetry basics, structured logging.  
**Build:**

- [ ] Add structured logging (pino) across services
- [ ] Expose Prometheus metrics (or simple `/metrics` endpoints)
- [ ] Add basic tracing (pass trace-id in headers)

**Deliverable:** Basic observability in place

---

### Day 13 — Integration testing & load test

**Learning:** Integration test patterns, k6 for load testing.  
**Build:**

- [ ] Write integration test for order→ticket→email flow (supertest + jest)
- [ ] Run a small load test for `/ticket/validate` (simulate 100 concurrent scans)
- [ ] Fix performance bottlenecks found

**Deliverable:** Tests & load results

---

### Day 14 — Polish & Deploy (local) + Documentation

**Learning:** Release notes, README, health checks.  
**Build:**

- [ ] Add health endpoints for each service
- [ ] Create README with run instructions and Postman collection
- [ ] Ensure `docker compose up -d` runs end-to-end
- [ ] Demo: create merchant, create order, receive email, validate ticket

**Milestone (Day 14):** MVP complete and demoable

---

## Testing, Postman and Deployment Tips

- Create a Postman collection with flows:
  - Register company → get API key
  - Create order with API key → verify `order.created` event
  - Inspect ticket in ticket-service DB → request retrieval link
  - Validate ticket with scan endpoint
- For deployment: containerize images, push to Docker Hub / AWS ECR and deploy to ECS / Kubernetes. For hackathon, you can use a single VM (DigitalOcean / Render / Railway) that runs your docker-compose or deploy microservices individually.

---

## Sample File Examples (key files)

### services/ticket-service/src/index.ts

```ts
import express from "express";
import mongoose from "mongoose";
import ticketRouter from "./routes/ticket";
import { connectRedis } from "./utils/redisClient";

const app = express();
app.use(express.json());
app.use("/ticket", ticketRouter);

mongoose.connect(process.env.MONGO_URI!);
connectRedis(process.env.REDIS_URL!);

app.listen(process.env.PORT || 4003, () => console.log("Ticket service up"));
```

### services/ticket-service/src/controllers/ticketController.ts

```ts
export const validateTicket = async (req, res) => {
  const { code } = req.body;
  // 1. check Redis cache
  // 2. if not in cache, query MongoDB
  // 3. if valid and not used: mark used atomically, respond success
  // 4. emit ticket.collected event to Kafka
};
```

### api-gateway/src/index.ts (simple proxy)

```ts
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
app.use(
  "/auth",
  createProxyMiddleware({
    target: "http://auth-service:4001",
    changeOrigin: true,
  })
);
app.use(
  "/order",
  createProxyMiddleware({
    target: "http://order-service:4002",
    changeOrigin: true,
  })
);
app.use(
  "/ticket",
  createProxyMiddleware({
    target: "http://ticket-service:4003",
    changeOrigin: true,
  })
);

app.listen(4000);
```

---

## Final Notes & Next Steps

- Keep your services small and focused. Do not prematurely optimize.
- Start with synchronous flows and introduce Kafka when you need decoupling; we've included Kafka from day 1 in this plan because you requested it.
- Security: use HTTPS in front of the API gateway, store secrets in env vars or secret manager, and rotate keys.
- After MVP: add analytics, fraud detection, multi-region databases, and enterprise onboarding features (SAML, billing integrations).

---

If you'd like, I can:

- Generate the actual `docker-compose.yml` and starter `Dockerfile`s for each service (I already included a template docker-compose above).
- Create a zip with skeleton code for each service (TypeScript + basic routes + Dockerfile).
- Generate a Postman collection for the flows.

Which of the three would you like next?