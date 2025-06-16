// server.js
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MediaSoup variables
let workers = [];
let nextWorkerIdx = 0;
const rooms = new Map();
const peers = new Map();

// MediaSoup configuration
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000
    }
  }
];

// Initialize MediaSoup workers
async function createWorkers() {
  const numWorkers = require('os').cpus().length;
  console.log(`Creating ${numWorkers} MediaSoup workers`);

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
      logLevel: 'warn',
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp'
      ]
    });

    worker.on('died', () => {
      console.error('MediaSoup worker died, exiting in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
  }
}

// Get next worker
function getNextWorker() {
  const worker = workers[nextWorkerIdx];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return worker;
}

// Create room
async function createRoom(roomId) {
  if (rooms.has(roomId)) {
    return rooms.get(roomId);
  }

  const worker = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs });

  const room = {
    id: roomId,
    router,
    producers: new Map(),
    consumers: new Map(),
    transports: new Map(),
    broadcasters: new Set()
  };

  rooms.set(roomId, room);
  return room;
}

// Generate TURN credentials
function generateTurnCredentials(userId) {
  // Using Metered TURN service with static credentials
  return {
    urls: [
      "stun:stun.relay.metered.ca:80",
      "turn:global.relay.metered.ca:80",
      "turn:global.relay.metered.ca:80?transport=tcp",
      "turn:global.relay.metered.ca:443",
      "turns:global.relay.metered.ca:443?transport=tcp"
    ],
    username: process.env.METERED_USERNAME || "f439a80264b73aed328cffdb",
    credential: process.env.METERED_PASSWORD || "6sPriw4qArYCJiav"
  };
}

// Main API endpoint
app.post('/api/video/connect', async (req, res) => {
  try {
    const { roomId, userId } = req.body;

    if (!roomId || !userId) {
      return res.status(400).json({ error: 'roomId and userId required' });
    }

    // Create room if doesn't exist
    await createRoom(roomId);

    // Generate unique stream ID
    const streamId = `${roomId}-${userId}`;

    // Generate token
    const token = crypto.randomBytes(32).toString('hex');

    // Store peer info
    peers.set(token, { roomId, userId, streamId });

    // Generate response
    // Updated code:
const isProduction = process.env.NODE_ENV === 'production' || process.env.SERVER_HOST !== 'localhost';
const protocol = isProduction ? 'wss' : 'ws';
const httpProtocol = isProduction ? 'https' : 'http';
const host = process.env.SERVER_HOST || 'localhost';
const port = isProduction ? '' : `:${process.env.PORT || 3000}`;

const response = {
  broadcaster: {
    url: `${protocol}://${host}${port}/socket.io/?token=${token}`,
    token,
    ice: generateTurnCredentials(userId)
  },
  viewer: {
    url: `${httpProtocol}://${host}${port}/stream/${streamId}.m3u8`
  }
};

    res.json(response);
  } catch (error) {
    console.error('Error in /api/video/connect:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket.IO connection handling
io.on('connection', async (socket) => {
  const token = socket.handshake.query.token;
  const peerInfo = peers.get(token);

  if (!peerInfo) {
    socket.disconnect();
    return;
  }

  const { roomId, userId, streamId } = peerInfo;
  const room = rooms.get(roomId);

  if (!room) {
    socket.disconnect();
    return;
  }

  socket.roomId = roomId;
  socket.userId = userId;
  socket.streamId = streamId;
  
  await socket.join(roomId);
  console.log(`User ${userId} connected to room ${roomId}`);
  console.log(`Socket ${socket.id} joined room ${roomId}`);

  // Send router RTP capabilities
  socket.emit('routerCapabilities', room.router.rtpCapabilities);

  // Notify about existing producers
  console.log(`Checking for existing producers in room ${roomId}...`);
  console.log(`Room has ${room.producers.size} producers`);
  
  for (const [producerId, producerInfo] of room.producers) {
    if (producerInfo.userId !== userId) {
      console.log(`Notifying ${userId} about existing producer from ${producerInfo.userId}`);
      socket.emit('newProducer', {
        producerId,
        userId: producerInfo.userId,
        kind: producerInfo.kind
      });
    }
  }

  // Handle transport creation
  socket.on('createTransport', async ({ producing, consuming }, callback) => {
    try {
      console.log(`🔧 Creating transport for ${userId}: producing=${producing}, consuming=${consuming}`);
      
      // Ensure callback is defined
      if (typeof callback !== 'function') {
        console.error(`❌ No callback provided for transport creation by ${userId}`);
        return;
      }

      const transport = producing
        ? await createWebRtcTransport(room.router, 'producer')
        : await createWebRtcTransport(room.router, 'consumer');

      console.log(`✅ Transport created: ${transport.id} for ${userId}`);

      room.transports.set(transport.id, {
        transport,
        userId,
        consuming,
        producing
      });

      console.log(`✅ Transport stored in room. Total transports: ${room.transports.size}`);

      const response = {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      };

      console.log(`📤 Sending transport response to ${userId}: ${transport.id}`);
      
      // Use setImmediate to ensure callback is called asynchronously
      setImmediate(() => {
        try {
          callback(response);
          console.log(`✅ Callback executed successfully for ${userId}`);
        } catch (callbackError) {
          console.error(`❌ Error in callback execution for ${userId}:`, callbackError);
        }
      });
      
    } catch (error) {
      console.error(`❌ Error creating transport for ${userId}:`, error);
      
      // Ensure callback is called even on error
      if (typeof callback === 'function') {
        setImmediate(() => {
          try {
            callback({ error: error.message });
            console.log(`✅ Error callback executed for ${userId}`);
          } catch (callbackError) {
            console.error(`❌ Error in error callback execution for ${userId}:`, callbackError);
          }
        });
      }
    }
  });

  // Handle transport connection
  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const transportInfo = room.transports.get(transportId);
      if (!transportInfo) {
        throw new Error('Transport not found');
      }

      await transportInfo.transport.connect({ dtlsParameters });
      callback({});
    } catch (error) {
      console.error('Error connecting transport:', error);
      callback({ error: error.message });
    }
  });

  // Handle producer creation
  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    try {
      const transportInfo = room.transports.get(transportId);
      if (!transportInfo) {
        throw new Error('Transport not found');
      }

      const producer = await transportInfo.transport.produce({
        kind,
        rtpParameters
      });

      room.producers.set(producer.id, {
        producer,
        userId,
        kind
      });

      room.broadcasters.add(userId);

      console.log(`Producer created: ${producer.id} by ${userId} (${kind})`);
      
      // Get all sockets in the room
      const roomSockets = await io.in(roomId).fetchSockets();
      console.log(`Room ${roomId} has ${roomSockets.length} sockets`);
      
      // Notify other peers
      for (const roomSocket of roomSockets) {
        if (roomSocket.userId !== userId) {
          console.log(`Notifying ${roomSocket.userId} about new producer from ${userId}`);
          roomSocket.emit('newProducer', {
            producerId: producer.id,
            userId,
            kind
          });
        }
      }

      callback({ id: producer.id });
    } catch (error) {
      console.error('Error creating producer:', error);
      callback({ error: error.message });
    }
  });

  // Handle consumer creation
  socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
    try {
      console.log(`🎯 Consumer request from ${userId} for producer ${producerId}`);
      
      const producerInfo = room.producers.get(producerId);
      if (!producerInfo) {
        console.log(`❌ Producer ${producerId} not found`);
        throw new Error('Producer not found');
      }

      console.log(`✅ Producer found: ${producerId} from ${producerInfo.userId} (${producerInfo.kind})`);

      if (!room.router.canConsume({
        producerId,
        rtpCapabilities
      })) {
        console.log(`❌ Cannot consume producer ${producerId} - RTP capabilities mismatch`);
        throw new Error('Cannot consume');
      }

      console.log(`✅ Router can consume producer ${producerId}`);

      // Find or create transport for consumer
      let transport;
      for (const [, transportInfo] of room.transports) {
        if (transportInfo.userId === userId && transportInfo.consuming) {
          transport = transportInfo.transport;
          console.log(`✅ Found existing consumer transport for ${userId}`);
          break;
        }
      }

      if (!transport) {
        console.log(`❌ No consumer transport found for ${userId}`);
        throw new Error('No consumer transport');
      }

      console.log(`🔄 Creating consumer for producer ${producerId}...`);
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false
      });

      console.log(`✅ Consumer created: ${consumer.id} for producer ${producerId} (${consumer.kind})`);

      room.consumers.set(consumer.id, {
        consumer,
        userId,
        producerId
      });

      const response = {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      };

      console.log(`📤 Sending consumer response to ${userId}:`, {
        id: response.id,
        producerId: response.producerId,
        kind: response.kind
      });

      callback(response);
    } catch (error) {
      console.error(`❌ Error creating consumer for ${userId}:`, error.message);
      callback({ error: error.message });
    }
  });

  // Handle refresh producers request
  socket.on('refresh-producers', () => {
    console.log(`🔄 ${userId} requested producer refresh`);
    
    // Send existing producers again
    for (const [producerId, producerInfo] of room.producers) {
      if (producerInfo.userId !== userId) {
        console.log(`🔄 Re-sending producer ${producerId} from ${producerInfo.userId} to ${userId}`);
        socket.emit('newProducer', {
          producerId,
          userId: producerInfo.userId,
          kind: producerInfo.kind
        });
      }
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const { roomId, userId } = socket;
    console.log(`User ${userId} disconnected from room ${roomId}`);

    // Clean up producers
    for (const [producerId, producerInfo] of room.producers) {
      if (producerInfo.userId === userId) {
        producerInfo.producer.close();
        room.producers.delete(producerId);
      }
    }

    // Clean up consumers
    for (const [consumerId, consumerInfo] of room.consumers) {
      if (consumerInfo.userId === userId) {
        consumerInfo.consumer.close();
        room.consumers.delete(consumerId);
      }
    }

    // Clean up transports
    for (const [transportId, transportInfo] of room.transports) {
      if (transportInfo.userId === userId) {
        transportInfo.transport.close();
        room.transports.delete(transportId);
      }
    }

    room.broadcasters.delete(userId);

    // Notify others
    socket.to(roomId).emit('peerDisconnected', { userId });

    // Clean up empty rooms
    if (room.broadcasters.size === 0) {
      room.router.close();
      rooms.delete(roomId);
    }
  });
});

// Create WebRTC transport
async function createWebRtcTransport(router, type) {
  const transport = await router.createWebRtcTransport({
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: process.env.ANNOUNCED_IP || '127.0.0.1'
      }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
    minimumAvailableOutgoingBitrate: 600000,
    maxSctpMessageSize: 262144,
    maxIncomingBitrate: 1500000
  });

  return transport;
}

// Simple HLS endpoint (mock - real implementation would transcode)
app.get('/stream/:streamId.m3u8', (req, res) => {
  const { streamId } = req.params;
  
  // This is a mock response. In production, you'd integrate with
  // FFmpeg or GStreamer to create real HLS streams
  res.type('application/vnd.apple.mpegurl');
  res.send(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
${streamId}_360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=842x480
${streamId}_480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
${streamId}_720p.m3u8`);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    workers: workers.length,
    rooms: rooms.size
  });
});

// Start server
async function start() {
  try {
    await createWorkers();
    
    const port = process.env.PORT || 3000;
    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log(`Media ports: 40000-49999`);
      console.log(`TURN server expected on port 3478`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
