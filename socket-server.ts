
import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import admin from 'firebase-admin';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Types for messages and data
interface Message {
  conversationId: string;
  senderId: string;
  content: string;
}

interface ReadData {
  conversationId: string;
  userId: string;
}

interface UnreadCountsUpdate {
  totalUnread: number;
  conversationCounts: Record<string, number>;
}

interface ConversationData {
  participants: string[];
  lastMessage?: string;
  updatedAt?: any;
  unreadCounts?: Record<string, number>;
}

// Initialize Firebase Admin SDK
function initializeFirebaseAdmin() {
  if (admin.apps.length > 0) return admin.apps[0];

  // Get service account credentials
  let serviceAccount;
  
  // Try to get from environment variable
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (error) {
      console.error('Error parsing FIREBASE_SERVICE_ACCOUNT:', error);
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT environment variable');
    }
  } else {
    // For local development, try to use individual environment variables
    serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };
    
    // Validate service account details
    if (!serviceAccount.projectId || !serviceAccount.privateKey || !serviceAccount.clientEmail) {
      throw new Error('Missing Firebase service account credentials in environment variables');
    }
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
}

// Initialize Firebase
initializeFirebaseAdmin();
const db = admin.firestore();

// Set up Express with CORS
const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 8080;

// Configure CORS
app.use(cors());

// Setup basic route for health check
app.get('/', (req, res) => {
  res.send('Socket.IO server is running');
});

// Setup Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: [
      process.env.PRODUCTION_URL || 'https://social-shake.vercel.app', 
      process.env.DEVELOPMENT_URL || 'http://localhost:3000',
      // Add other allowed origins as needed
    ],
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['polling', 'websocket']
});

// Helper function to emit unread counts to a specific user
async function emitUnreadCounts(userId: string): Promise<void> {
  try {
    // Query conversations where the user is a participant
    const conversationsRef = db.collection('conversations');
    const snapshot = await conversationsRef
      .where('participants', 'array-contains', userId)
      .get();

    let totalUnread = 0;
    const conversationCounts: Record<string, number> = {};

    // Sum up all unread counts across all conversations
    snapshot.docs.forEach((doc) => {
      const data = doc.data() as ConversationData;
      const unreadCount = data.unreadCounts?.[userId] || 0;
      totalUnread += unreadCount;
      conversationCounts[doc.id] = unreadCount;
    });

    // Emit to this specific user's room
    io.to(`user-${userId}`).emit('unread-counts-update', {
      totalUnread,
      conversationCounts,
    } as UnreadCountsUpdate);
  } catch (error) {
    console.error('Error emitting unread counts:', error);
  }
}

// Socket connection handling
io.on('connection', (socket: Socket) => {
  console.log('A client connected:', socket.id);
  
  // Join conversation rooms
  socket.on('join-conversation', (conversationId: string) => {
    console.log(`User ${socket.id} joined conversation ${conversationId}`);
    socket.join(conversationId);
  });

  // Leave conversation room
  socket.on('leave-conversation', (conversationId: string) => {
    console.log(`User ${socket.id} left conversation ${conversationId}`);
    socket.leave(conversationId);
  });

  // Handle new message
  socket.on('send-message', async (message: Message) => {
    try {
      const { conversationId, senderId, content } = message;

      if (!conversationId || !senderId || !content.trim()) {
        socket.emit('error', 'Missing required fields');
        return;
      }

      // Check if conversation exists
      const conversationRef = db
        .collection('conversations')
        .doc(conversationId);
      const conversationDoc = await conversationRef.get();

      if (!conversationDoc.exists) {
        socket.emit('error', 'Conversation not found');
        return;
      }

      // Get conversation data and participants
      const conversationData = conversationDoc.data() as ConversationData;
      const participants = conversationData?.participants || [];

      // Get other participants to mark message as unread for them
      const otherParticipants = participants.filter(
        (id) => id !== senderId
      );

      // Create readStatus object with all recipients marked as unread
      const readStatus: Record<string, boolean> = {};
      otherParticipants.forEach((participantId) => {
        readStatus[participantId] = false;
      });
      // The sender has read their own message
      readStatus[senderId] = true;

      // Get current timestamp for emitting to clients
      const clientTimestamp = new Date().toISOString();

      // Add message to the conversation's messages subcollection
      const messageRef = await conversationRef.collection('messages').add({
        sender: senderId,
        content: content,
        timestamp: admin.firestore.FieldValue.serverTimestamp(), // Use server timestamp for storage
        readStatus: readStatus, // Add read status for each recipient
      });

      // Get the message data to emit to clients
      const messageData = {
        id: messageRef.id,
        sender: senderId,
        content: content,
        timestamp: clientTimestamp,
        conversationId: conversationId, // Include conversationId in the message
      };

      // Update conversation with last message, timestamp, and unread counts
      const updateData: Record<string, any> = {
        lastMessage: content,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Increment unread count for all other participants
      for (const participantId of otherParticipants) {
        updateData[`unreadCounts.${participantId}`] = admin.firestore.FieldValue.increment(1);
      }

      await conversationRef.update(updateData);

      // Emit the new message to all users in the conversation
      io.to(conversationId).emit('new-message', messageData);

      // For each participant, emit updated unread counts
      if (conversationData && conversationData.participants) {
        for (const participantId of conversationData.participants) {
          // Don't emit to the sender since they don't have unread messages
          if (participantId !== senderId) {
            await emitUnreadCounts(participantId);
          }
        }
      }

      // Also emit a conversation update to all relevant users
      if (conversationData && conversationData.participants) {
        // Broadcast to all participants that the conversation was updated
        conversationData.participants.forEach((participantId) => {
          io.to(`user-${participantId}`).emit('conversation-updated', {
            conversationId,
            lastMessage: content,
            updatedAt: clientTimestamp,
            unreadCounts: conversationData.unreadCounts || {}, // Include unread counts in update
          });
        });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      socket.emit('error', 'Failed to send message');
    }
  });

  socket.on('mark-read', async (data: ReadData) => {
    try {
      const { conversationId, userId } = data;
      
      // Update the conversation document to reset unread count
      const conversationRef = db.collection('conversations').doc(conversationId);
      await conversationRef.update({
        [`unreadCounts.${userId}`]: 0
      });
      
      // Mark all messages as read in the database
      const messagesRef = conversationRef.collection('messages');
      const unreadMessages = await messagesRef.where(`readStatus.${userId}`, '==', false).get();
      
      const batch = db.batch();
      unreadMessages.docs.forEach(doc => {
        batch.update(doc.ref, {
          [`readStatus.${userId}`]: true
        });
      });
      
      if (unreadMessages.size > 0) {
        await batch.commit();
      }
      
      // Emit updated unread counts to this user
      await emitUnreadCounts(userId);
      
    } catch (error) {
      console.error('Error marking as read:', error);
      socket.emit('error', 'Failed to mark messages as read');
    }
  });

  // Subscribe to user-specific updates
  socket.on('subscribe-user', (userId: string) => {
    if (userId) {
      console.log(`User ${socket.id} subscribed as ${userId}`);
      socket.join(`user-${userId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start the server
server.listen(port, () => {
  console.log(`Socket.IO server running on port ${port}`);
  console.log(`Socket.IO configuration:`, {
    cors: io.engine.opts.cors,
    transports: io.engine.opts.transports
  });
});