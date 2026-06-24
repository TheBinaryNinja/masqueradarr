// externalPlayer engine preset catalog — the picker's source of truth (Settings → Video Configuration).
// Selecting a preset POPULATES the engine's Advanced single-line input with `args`; the server substitutes
// the spawn placeholders <INPUT> <UA> <OUTDIR> <M3U8> <SEG> at run time. Strings transcribed from the
// ffmpeg/VLC research (Part D). `output` notes which output format the preset targets (hls = the default
// loopback path; ts = the raw-TS passthrough path); `needsHw` flags hardware-encoder presets so the card can
// gate them on detected host capability.

export interface VideoPreset {
  name: string;
  args: string;
  output: 'hls' | 'ts';
  needsHw?: boolean;
  hint?: string;
}

export const FFMPEG_PRESETS: VideoPreset[] = [
  {
    name: 'Remux / Copy (lowest CPU)',
    output: 'hls',
    hint: 'Stream-copy, lossless, near-zero CPU — only works when the source is already browser-safe H.264/AAC.',
    args:
      '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 ' +
      '-fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? -c copy -copyts -f hls -hls_time 6 -hls_list_size 6 ' +
      '-hls_flags delete_segments+independent_segments+omit_endlist -hls_segment_filename "<OUTDIR>/seg_%05d.ts" "<M3U8>"',
  },
  {
    name: 'Remux / Copy → raw MPEG-TS',
    output: 'ts',
    hint: 'Stream-copy to a held-open MPEG-TS socket — the classic raw IPTV link, for raw-only clients. Pairs with the Raw TS output mode.',
    args:
      '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 ' +
      '-fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? -c copy -copyts -f mpegts pipe:1',
  },
  {
    name: 'Low-latency H.264 (software)',
    output: 'hls',
    hint: 'Transcode to H.264 with x264 veryfast + zerolatency. Universal compatibility, moderate CPU.',
    args:
      '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 ' +
      '-fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? -c:v libx264 -preset veryfast -tune zerolatency ' +
      '-profile:v high -pix_fmt yuv420p -sc_threshold 0 -g 60 -keyint_min 60 -force_key_frames "expr:gte(t,n_forced*2)" ' +
      '-crf 23 -maxrate 4000k -bufsize 4000k -c:a aac -b:a 128k -ac 2 -ar 48000 -f hls -hls_time 2 -hls_list_size 6 ' +
      '-hls_flags delete_segments+independent_segments+omit_endlist -hls_segment_filename "<OUTDIR>/seg_%05d.ts" "<M3U8>"',
  },
  {
    name: '720p transcode (software)',
    output: 'hls',
    hint: 'Scale to 720p and transcode to H.264 — caps bandwidth per stream.',
    args:
      '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 ' +
      '-fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? -vf "scale=-2:720" -c:v libx264 -preset veryfast -tune zerolatency ' +
      '-profile:v high -pix_fmt yuv420p -sc_threshold 0 -g 60 -keyint_min 60 -crf 23 -maxrate 3000k -bufsize 6000k ' +
      '-c:a aac -b:a 128k -ac 2 -ar 48000 -f hls -hls_time 2 -hls_list_size 6 ' +
      '-hls_flags delete_segments+independent_segments+omit_endlist -hls_segment_filename "<OUTDIR>/seg_%05d.ts" "<M3U8>"',
  },
  {
    name: '1080p transcode (software)',
    output: 'hls',
    hint: 'Scale to 1080p and transcode to H.264 at a higher bitrate ceiling.',
    args:
      '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 ' +
      '-fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? -vf "scale=-2:1080" -c:v libx264 -preset veryfast -tune zerolatency ' +
      '-profile:v high -pix_fmt yuv420p -sc_threshold 0 -g 60 -keyint_min 60 -crf 22 -maxrate 6000k -bufsize 12000k ' +
      '-c:a aac -b:a 192k -ac 2 -ar 48000 -f hls -hls_time 2 -hls_list_size 6 ' +
      '-hls_flags delete_segments+independent_segments+omit_endlist -hls_segment_filename "<OUTDIR>/seg_%05d.ts" "<M3U8>"',
  },
  {
    name: 'Hardware NVENC (1080p)',
    output: 'hls',
    needsHw: true,
    hint: 'GPU-accelerated H.264 via NVIDIA NVENC — far lower CPU for many simultaneous transcodes. Requires an NVENC-capable host.',
    args:
      '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 ' +
      '-fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? -vf "scale=-2:1080" -c:v h264_nvenc -preset p4 -tune ll ' +
      '-rc vbr -cq 23 -b:v 6000k -maxrate 6000k -bufsize 6000k -g 60 -keyint_min 60 -no-scenecut 1 ' +
      '-c:a aac -b:a 192k -ac 2 -ar 48000 -f hls -hls_time 2 -hls_list_size 6 ' +
      '-hls_flags delete_segments+independent_segments+omit_endlist -hls_segment_filename "<OUTDIR>/seg_%05d.ts" "<M3U8>"',
  },
  {
    name: 'Hardware QSV (Intel)',
    output: 'hls',
    needsHw: true,
    hint: 'GPU-accelerated H.264 via Intel Quick Sync (h264_qsv) — low CPU. Requires an Intel iGPU + /dev/dri passthrough.',
    args:
      '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 ' +
      '-fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? -c:v h264_qsv -global_quality 23 -b:v 6000k -maxrate 6000k ' +
      '-bufsize 6000k -g 60 -c:a aac -b:a 192k -ac 2 -ar 48000 -f hls -hls_time 2 -hls_list_size 6 ' +
      '-hls_flags delete_segments+independent_segments+omit_endlist -hls_segment_filename "<OUTDIR>/seg_%05d.ts" "<M3U8>"',
  },
  {
    name: 'Hardware VAAPI (Intel/AMD)',
    output: 'hls',
    needsHw: true,
    hint: 'GPU-accelerated H.264 via VAAPI (h264_vaapi) — Intel/AMD on Linux. Requires /dev/dri/renderD128 passthrough.',
    args:
      '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 ' +
      '-vaapi_device /dev/dri/renderD128 -fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? ' +
      '-vf "format=nv12,hwupload" -c:v h264_vaapi -qp 23 -b:v 6000k -maxrate 6000k -bufsize 6000k -g 60 ' +
      '-c:a aac -b:a 192k -ac 2 -ar 48000 -f hls -hls_time 2 -hls_list_size 6 ' +
      '-hls_flags delete_segments+independent_segments+omit_endlist -hls_segment_filename "<OUTDIR>/seg_%05d.ts" "<M3U8>"',
  },
  {
    name: 'Audio-only',
    output: 'hls',
    hint: 'Drop video; serve an AAC audio-only HLS stream.',
    args:
      '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 4 ' +
      '-i "<INPUT>" -vn -map 0:a:0 -c:a aac -b:a 128k -ac 2 -ar 48000 -f hls -hls_time 4 -hls_list_size 6 ' +
      '-hls_flags delete_segments+omit_endlist -hls_segment_filename "<OUTDIR>/seg_%05d.aac" "<M3U8>"',
  },
];

export const VLC_PRESETS: VideoPreset[] = [
  {
    name: 'Remux / Copy → HLS',
    output: 'hls',
    hint: 'No transcode; package the source into a live HLS window via VLC livehttp.',
    args:
      '-I dummy --http-user-agent "<UA>" --network-caching 1500 "<INPUT>" vlc://quit ' +
      "--sout '#std{access=livehttp{seglen=6,delsegs=true,numsegs=6,index=<M3U8>,index-url=<SEG>-########.ts}," +
      "mux=ts{use-key-frames},dst=<SEG>-########.ts}'",
  },
  {
    name: 'Low-latency H.264 → HLS',
    output: 'hls',
    hint: 'Transcode to H.264 (x264 ultrafast/zerolatency) into a live HLS window.',
    args:
      '-I dummy --http-user-agent "<UA>" --network-caching 1500 "<INPUT>" vlc://quit ' +
      "--sout '#transcode{vcodec=h264,venc=x264{preset=ultrafast,tune=zerolatency,keyint=60},vb=4000,acodec=mp4a,ab=128," +
      'channels=2,samplerate=48000}:std{access=livehttp{seglen=2,delsegs=true,numsegs=6,index=<M3U8>,' +
      "index-url=<SEG>-########.ts},mux=ts{use-key-frames},dst=<SEG>-########.ts}'",
  },
  {
    name: '720p transcode → HLS',
    output: 'hls',
    hint: 'Scale to 720p and transcode to H.264 into a live HLS window.',
    args:
      '-I dummy --http-user-agent "<UA>" --network-caching 1500 "<INPUT>" vlc://quit ' +
      "--sout '#transcode{vcodec=h264,venc=x264{preset=veryfast,tune=zerolatency,keyint=60},vb=3000,height=720," +
      'acodec=mp4a,ab=128,channels=2,samplerate=48000,deinterlace}:std{access=livehttp{seglen=2,delsegs=true,numsegs=6,' +
      "index=<M3U8>,index-url=<SEG>-########.ts},mux=ts{use-key-frames},dst=<SEG>-########.ts}'",
  },
  {
    name: 'Remux / Copy → raw MPEG-TS',
    output: 'ts',
    hint: 'Raw MPEG-TS to stdout — the server pipes it through the shared ring buffer to clients (classic IPTV link). Pairs with the Raw TS output mode.',
    args:
      '-I dummy --http-user-agent "<UA>" --network-caching 1500 "<INPUT>" vlc://quit ' +
      "--sout '#std{access=file,mux=ts,dst=/dev/stdout}'",
  },
  {
    name: 'Audio-only → raw MPEG-TS',
    output: 'ts',
    hint: 'Drop video; mux AAC audio as MPEG-TS to stdout (served via the ring buffer).',
    args:
      '-I dummy --http-user-agent "<UA>" --network-caching 1500 "<INPUT>" vlc://quit ' +
      "--sout '#transcode{vcodec=none,acodec=mp4a,ab=128,channels=2,samplerate=48000}:std{access=file,mux=ts,dst=/dev/stdout}'",
  },
];

export function presetsFor(engine: 'ffmpeg' | 'vlc'): VideoPreset[] {
  return engine === 'vlc' ? VLC_PRESETS : FFMPEG_PRESETS;
}
