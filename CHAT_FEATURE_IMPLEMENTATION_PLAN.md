# Chat/Support Feature Implementation Plan

## Current Status
❌ **NOT IMPLEMENTED** - No chat/messaging functionality exists in the codebase.

## Complexity Assessment: **MEDIUM** ⚠️

### Why Medium Complexity?

**Pros (Makes it easier):**
- ✅ Existing microservices architecture is well-structured
- ✅ Kafka event system already in place (can use for notifications)
- ✅ Authentication/authorization patterns established
- ✅ MongoDB setup with multi-database pattern
- ✅ Redis available for caching/real-time features

**Challenges:**
- ⚠️ Need to add real-time communication (WebSockets or polling)
- ⚠️ New service or extend existing service
- ⚠️ Message persistence and conversation threading
- ⚠️ Read receipts and typing indicators (optional but nice)
- ⚠️ File attachments (optional but useful)

## Recommended Implementation Approach

### Option 1: New Messaging Service (Recommended) ⭐
**Pros:**
- Clean separation of concerns
- Can scale independently
- Easier to maintain
- Follows existing microservices pattern

**Cons:**
- One more service to manage
- Additional service-to-service communication

### Option 2: Extend Company Service
**Pros:**
- Fewer services
- Company context already available

**Cons:**
- Mixes concerns (company management + messaging)
- Harder to scale messaging independently

## Implementation Plan

### Phase 1: Core Messaging (MVP)
1. **Create Messaging Service** (Port 4006)
   - Conversation model (threads between merchant and CF admin)
   - Message model (individual messages)
   - REST endpoints for sending/receiving messages
   - Polling-based real-time (simpler than WebSockets initially)

2. **Database Schema**
   ```typescript
   Conversation {
     _id: ObjectId
     companyId: string
     companyName: string
     companyAdminEmail: string
     cfAdminId?: string
     cfAdminEmail?: string
     subject: string
     status: 'open' | 'resolved' | 'closed'
     lastMessageAt: Date
     createdAt: Date
     updatedAt: Date
   }

   Message {
     _id: ObjectId
     conversationId: ObjectId
     senderType: 'merchant' | 'cf_admin'
     senderId: string
     senderEmail: string
     senderName: string
     content: string
     read: boolean
     readAt?: Date
     attachments?: Array<{ filename, url, type }>
     createdAt: Date
   }
   ```

3. **API Endpoints**
   ```
   POST /messaging/conversations - Create new conversation (merchant)
   GET /messaging/conversations - List conversations (both roles)
   GET /messaging/conversations/:id - Get conversation with messages
   POST /messaging/conversations/:id/messages - Send message
   PATCH /messaging/conversations/:id/status - Update status (CF admin)
   PATCH /messaging/messages/:id/read - Mark as read
   GET /messaging/conversations/:id/messages - Get messages (paginated)
   ```

### Phase 2: Real-Time Updates
1. **WebSocket Support** (using Socket.io or native WebSockets)
   - Real-time message delivery
   - Typing indicators
   - Online status
   - Push notifications for new messages

2. **Kafka Integration**
   - Publish `message_created` events
   - Notification service can send email notifications
   - Dashboard can subscribe for real-time updates

### Phase 3: Enhanced Features
1. **File Attachments**
   - Image uploads
   - Document sharing
   - Integration with storage (S3, local storage)

2. **Advanced Features**
   - Message search
   - Conversation tags/categories
   - Priority levels
   - Auto-assignment to CF admins
   - Conversation analytics

## Technical Stack Recommendations

### Backend
- **Service**: New `messaging-service` (Node.js + TypeScript + Express)
- **Database**: MongoDB (separate `messaging` database)
- **Real-time**: Socket.io (easier than raw WebSockets)
- **Storage**: Local filesystem or S3 for attachments
- **Events**: Kafka for notifications

### Frontend Integration
- **WebSocket Client**: Socket.io-client
- **UI Component**: Chat widget/panel
- **Notifications**: Toast notifications for new messages
- **Badge Counts**: Unread message indicators

## Estimated Implementation Time

- **Phase 1 (MVP)**: 2-3 days
  - Service setup
  - Models and routes
  - Basic CRUD operations
  - Polling-based updates

- **Phase 2 (Real-time)**: 2-3 days
  - WebSocket integration
  - Real-time message delivery
  - Kafka events

- **Phase 3 (Enhanced)**: 3-5 days
  - File attachments
  - Advanced features
  - Polish and optimization

**Total: ~7-11 days** for full implementation

## Integration Points

1. **Company Service**: Get company info for conversations
2. **Auth Service**: Verify CF admin tokens
3. **Notification Service**: Email notifications for new messages
4. **API Gateway**: Route messaging endpoints
5. **Dashboard**: Real-time chat UI component

## Security Considerations

- ✅ Only merchants can create conversations
- ✅ Merchants can only see their own conversations
- ✅ CF admins can see all conversations
- ✅ Message content validation
- ✅ File upload size limits
- ✅ Rate limiting on message creation
- ✅ Audit logging for all messages

## Next Steps

1. Create messaging-service directory structure
2. Implement Conversation and Message models
3. Create REST endpoints
4. Add WebSocket support
5. Integrate with API Gateway
6. Add Kafka events
7. Update dashboard UI prompt with chat requirements

