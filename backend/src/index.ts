import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';
import cors from 'cors';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Serve static files from the public directory
app.use('/hls', express.static(path.join(__dirname, '../public/hls')));

// Mediasoup workers
let mediasoupWorker: mediasoup.types.Worker;
let router: mediasoup.types.Router;
let producerTransports: Map<string, mediasoup.types.WebRtcTransport> = new Map();
let producers: Map<string, mediasoup.types.Producer> = new Map();
let consumers: Map<string, mediasoup.types.Consumer> = new Map();

// Initialize mediasoup
async function initializeMediasoup() {
  mediasoupWorker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });

  router = await mediasoupWorker.createRouter({
    mediaCodecs: [
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000
        }
      },
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      }
    ]
  });
}

// Socket.io connection handling
io.on('connection', async (socket) => {
  console.log('Client connected:', socket.id);

  // Handle WebRTC transport creation
  socket.on('createWebRtcTransport', async (callback) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      producerTransports.set(socket.id, transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (error) {
      console.error('Error creating transport:', error);
      callback({ error: 'Failed to create transport' });
    }
  });

  // Handle producer transport connection
  socket.on('connectProducerTransport', async ({ transportId, dtlsParameters }, callback) => {
    const transport = producerTransports.get(socket.id);
    if (!transport) {
      callback({ error: 'Transport not found' });
      return;
    }

    await transport.connect({ dtlsParameters });
    callback();
  });

  // Handle producer creation
  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    const transport = producerTransports.get(socket.id);
    if (!transport) {
      callback({ error: 'Transport not found' });
      return;
    }

    const producer = await transport.produce({ kind, rtpParameters });
    producers.set(socket.id, producer);

    // Start HLS transcoding for viewers
    if (kind === 'video') {
      startHlsTranscoding(socket.id);
    }

    callback({ id: producer.id });
  });

  // Handle consumer creation
  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    const transport = producerTransports.get(socket.id);
    if (!transport) {
      callback({ error: 'Transport not found' });
      return;
    }

    if (!router.canConsume({ producerId, rtpCapabilities })) {
      callback({ error: 'Cannot consume' });
      return;
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });

    consumers.set(socket.id, consumer);

    callback({
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerId: producerId,
    });
  });

  // Handle consumer resume
  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    const consumer = consumers.get(socket.id);
    if (!consumer) {
      callback({ error: 'Consumer not found' });
      return;
    }

    await consumer.resume();
    callback();
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    producerTransports.delete(socket.id);
    producers.delete(socket.id);
    consumers.delete(socket.id);
  });
});

// HLS transcoding function
function startHlsTranscoding(streamId: string) {
  const outputDir = path.join(__dirname, '../public/hls', streamId);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Clean up any existing files
  fs.readdirSync(outputDir).forEach(file => {
    fs.unlinkSync(path.join(outputDir, file));
  });

  ffmpeg()
    .input('pipe:0')
    .inputOptions([
      '-f webm',
      '-i pipe:0',
    ])
    .outputOptions([
      '-c:v libx264',
      '-c:a aac',
      '-f hls',
      '-hls_time 2',
      '-hls_list_size 3',
      '-hls_flags delete_segments',
      '-hls_segment_filename', `${outputDir}/%d.ts`,
    ])
    .output(`${outputDir}/playlist.m3u8`)
    .on('error', (err) => {
      console.error('FFmpeg error:', err);
    })
    .on('end', () => {
      console.log('FFmpeg transcoding finished');
    })
    .run();
}

// Initialize mediasoup and start server
initializeMediasoup().then(() => {
  const PORT = process.env.PORT || 3008;
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});