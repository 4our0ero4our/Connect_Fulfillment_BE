# Connect Fulfillment - Starter Skeleton

Run `docker compose up --build` to bring up the dev environment.


Run `docker compose logs -f <service>` to log
## Available Routes or Now (via API Gateway @ http://localhost:4000)

### Gateway
- GET `/` – API info
- GET `/health` – Gateway health

### Auth Service
- GET `/auth`
- GET `/auth/health`
- POST `/auth/register`
- POST `/auth/login`

### Order Service
- GET `/order`
- GET `/order/health`
- POST `/order`
- GET `/order/:id`

### Ticket Service
- GET `/ticket`
- GET `/ticket/health`
- POST `/ticket/validate`

### Company Service
- GET `/company`
- GET `/company/verify/:apikey`
- GET `/company/health`

### Notification Service
- GET `/notify`
- GET `/notify/health`
- POST `/notify/send`
