'use client';

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

const WatchPage = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
    });

    hls.loadSource('http://localhost:3008/hls/stream/playlist.m3u8');
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch((err) => {
        setError('Failed to play video: ' + err.message);
      });
      setIsPlaying(true);
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            setError('Network error occurred. Trying to recover...');
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            setError('Media error occurred. Trying to recover...');
            hls.recoverMediaError();
            break;
          default:
            setError('Fatal error occurred. Please refresh the page.');
            hls.destroy();
            break;
        }
      }
    });

    return () => {
      hls.destroy();
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Watch Live Stream</h1>

        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        <div className="bg-white rounded-lg shadow-lg p-4">
          <video
            ref={videoRef}
            controls
            className="w-full rounded-lg"
            playsInline
          />
        </div>

        <div className="mt-4">
          <p className="text-gray-600">
            Status: {isPlaying ? 'Playing' : 'Loading...'}
          </p>
        </div>
      </div>
    </div>
  );
};

export default WatchPage; 