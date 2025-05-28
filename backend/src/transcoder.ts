import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export function generateSdpFile({ port, codec }: { port: number, codec: string }) {
  return `
v=0
o=- 0 0 IN IP4 127.0.0.1
s=Mediasoup Stream
c=IN IP4 127.0.0.1
t=0 0
m=video ${port} RTP/AVP 96
a=rtpmap:96 ${codec}/90000
`.trim();
}

export function startHlsTranscoding({ streamId, port, codec }: { streamId: string, port: number, codec: string }) {
  const outputDir = path.join(__dirname, '../public/hls', streamId);
  const sdpPath = path.join(outputDir, 'stream.sdp');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Clean up any existing files
  fs.readdirSync(outputDir).forEach(file => {
    fs.unlinkSync(path.join(outputDir, file));
  });

  fs.writeFileSync(sdpPath, generateSdpFile({ port, codec }));

  const ffmpeg = spawn('ffmpeg', [
    '-protocol_whitelist', 'file,udp,rtp',
    '-i', sdpPath,
    '-c:v', 'libx264',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '3',
    '-hls_flags', 'delete_segments',
    '-hls_segment_filename', path.join(outputDir, 'segment_%d.ts'),
    path.join(outputDir, 'playlist.m3u8')
  ]);

  ffmpeg.stderr.on('data', (data) => {
    console.error(`FFmpeg stderr: ${data}`);
  });

  ffmpeg.on('exit', (code) => {
    console.log(`FFmpeg exited with code ${code}`);
  });

  return ffmpeg;
} 