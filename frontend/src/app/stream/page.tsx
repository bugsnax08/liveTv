'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const StreamPage = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<{ video: MediaDeviceInfo[], audio: MediaDeviceInfo[] }>({ video: [], audio: [] });
  const [selectedDevices, setSelectedDevices] = useState<{ video: string, audio: string }>({ video: '', audio: '' });

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const deviceRef = useRef<mediasoupClient.types.Device | null>(null);
  const producerTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const consumerTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const producerRef = useRef<mediasoupClient.types.Producer | null>(null);
  const consumerRef = useRef<mediasoupClient.types.Consumer | null>(null);

  useEffect(() => {
    const socket = io('http://localhost:3008');
    setSocket(socket);

    socket.on('connect', () => {
      setIsConnected(true);
      loadDevices();
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const loadDevices = async () => {
    try {
      // First request permissions to get device labels
      await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      console.log('All devices:', devices); // Debug log
      
      const videoDevices = devices.filter(device => device.kind === 'videoinput');
      const audioDevices = devices.filter(device => device.kind === 'audioinput');
      
      console.log('Video devices:', videoDevices); // Debug log
      console.log('Audio devices:', audioDevices); // Debug log
      
      setDevices({ video: videoDevices, audio: audioDevices });
      
      if (videoDevices.length === 0 && audioDevices.length === 0) {
        setError('No camera or microphone found. Please check your device connections and browser permissions.');
      } else if (videoDevices.length === 0) {
        setError('No camera found. Please connect a camera and refresh the page.');
      } else if (audioDevices.length === 0) {
        setError('No microphone found. Please connect a microphone and refresh the page.');
      } else {
        setSelectedDevices({
          video: videoDevices[0].deviceId,
          audio: audioDevices[0].deviceId
        });
        initializeMedia();
      }
    } catch (err) {
      console.error('Error loading devices:', err);
      if (err instanceof DOMException) {
        switch (err.name) {
          case 'NotAllowedError':
            setError('Camera and microphone access was denied. Please allow access in your browser settings and refresh the page.');
            break;
          case 'NotFoundError':
            setError('No camera or microphone found. Please check your device connections.');
            break;
          default:
            setError(`Failed to access media devices: ${err.message}`);
        }
      } else {
        setError('Failed to load media devices. If running in VirtualBox, please check: 1) Guest Additions are installed 2) USB devices are enabled in VM settings 3) USB filters are added for your devices');
      }
    }
  };

  const initializeMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: selectedDevices.video ? { exact: selectedDevices.video } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        },
        audio: {
          deviceId: selectedDevices.audio ? { exact: selectedDevices.audio } : undefined,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      deviceRef.current = new mediasoupClient.Device();
      await createWebRtcTransport();
    } catch (err) {
      console.error('Media access error:', err);
      if (err instanceof DOMException) {
        switch (err.name) {
          case 'NotAllowedError':
            setError('Camera and microphone access was denied. Please allow access and refresh the page.');
            break;
          case 'NotFoundError':
            setError('No camera or microphone found. Please connect a device and refresh the page.');
            break;
          case 'NotReadableError':
            setError('Camera or microphone is already in use by another application.');
            break;
          default:
            setError(`Failed to access media devices: ${err.message}`);
        }
      } else {
        setError('Failed to access media devices. Please check your browser settings.');
      }
    }
  };

  const handleDeviceChange = async (type: 'video' | 'audio', deviceId: string) => {
    setSelectedDevices(prev => ({ ...prev, [type]: deviceId }));
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    await initializeMedia();
  };

  const createWebRtcTransport = async () => {
    if (!socket) return;

    socket.emit('createWebRtcTransport', async (response: any) => {
      if (response.error) {
        setError(response.error);
        return;
      }

      await deviceRef.current?.load({ routerRtpCapabilities: response.routerRtpCapabilities });

      const transport = deviceRef.current?.createSendTransport({
        id: response.id,
        iceParameters: response.iceParameters,
        iceCandidates: response.iceCandidates,
        dtlsParameters: response.dtlsParameters,
      });

      if (!transport) {
        setError('Failed to create transport');
        return;
      }

      producerTransportRef.current = transport;

      producerTransportRef.current?.on('connect', async ({ dtlsParameters }, callback, errback) => {
        socket.emit('connectProducerTransport', {
          transportId: producerTransportRef.current?.id,
          dtlsParameters,
        }, callback);
      });

      producerTransportRef.current?.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        socket.emit('produce', {
          transportId: producerTransportRef.current?.id,
          kind,
          rtpParameters,
        }, ({ id }: { id: string }) => {
          callback({ id });
        });
      });

      await startProducing();
    });
  };

  const startProducing = async () => {
    if (!localStream || !producerTransportRef.current) return;

    const videoTrack = localStream.getVideoTracks()[0];
    const audioTrack = localStream.getAudioTracks()[0];

    if (videoTrack) {
      producerRef.current = await producerTransportRef.current.produce({
        track: videoTrack,
        encodings: [
          { maxBitrate: 100000, scalabilityMode: 'S3T3' },
        ],
        codecOptions: {
          videoGoogleStartBitrate: 1000,
        },
      });
    }

    if (audioTrack) {
      producerRef.current = await producerTransportRef.current.produce({
        track: audioTrack,
        encodings: [
          { maxBitrate: 64000 },
        ],
        codecOptions: {
          opusStereo: true,
          opusDtx: true,
        },
      });
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Live Stream</h1>
        
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        <div className="mb-8 grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Camera</label>
            <select
              className="w-full p-2 border rounded"
              value={selectedDevices.video}
              onChange={(e) => handleDeviceChange('video', e.target.value)}
            >
              {devices.video.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${device.deviceId.slice(0, 5)}`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Microphone</label>
            <select
              className="w-full p-2 border rounded"
              value={selectedDevices.audio}
              onChange={(e) => handleDeviceChange('audio', e.target.value)}
            >
              {devices.audio.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${device.deviceId.slice(0, 5)}`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-8">
          <div className="bg-white rounded-lg shadow-lg p-4">
            <h2 className="text-xl font-semibold mb-4">Your Stream</h2>
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full rounded-lg"
            />
          </div>

          <div className="bg-white rounded-lg shadow-lg p-4">
            <h2 className="text-xl font-semibold mb-4">Remote Stream</h2>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full rounded-lg"
            />
          </div>
        </div>

        <div className="mt-8">
          <p className="text-gray-600">
            Status: {isConnected ? 'Connected' : 'Disconnected'}
          </p>
        </div>
      </div>
    </div>
  );
};

export default StreamPage; 