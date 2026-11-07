---
kind: render
# Frame sizes: the preview is for looking, the final is the MP4 you keep.
preview: { width: 960, height: 540 }
final: { width: 1920, height: 1080 }
# Puppets step at `anim` frames per second (animation "on twos"); the video is `out` frames per second; camera moves are smooth at `out`.
fps: { anim: 12, out: 24 }
# The first encoder that works on this machine is used (the render probes them in this order).
encoders:
  - { name: h264_amf }
  - { name: libx264, preset: veryfast, crf: 20 }
pixelFormat: yuv420p
# Frames travel from the browser to ffmpeg as jpeg (fast) or png (lossless).
frameFormat: jpeg
audio: { codec: aac, bitrate: 160k }
# The mix: integrated loudness in LUFS and true peak in dBTP.
loudness: { lufs: -16, truePeak: -1.5 }
# The levels, all relative to the voice. Each input file is measured (integrated LUFS) and brought to its level first; the whole mix is
# normalised to `loudness` after that, so the distances stay. The music sits `musicGapUnderVoiceDb` under the voice in the gaps and
# `musicUnderVoiceDb` under it while someone speaks. The mix check (render/<lang>/mix-check.json) warns (W_MIX_MUSIC_LOUD) when the
# quietest line has the music less than `minUnderVoiceDb` under the voice.
mix: { voiceLufs: -20, musicUnderVoiceDb: 18, musicGapUnderVoiceDb: 8, sfxUnderVoiceDb: 6, clipUnderVoiceDb: 10, minUnderVoiceDb: 15 }
---
# Render

How an episode becomes an MP4 (CTS-05 reads this file). The base animation is drawn by the Canvas player in headless Chromium, one frame per `renderFrame(i)`, and the frames are piped to ffmpeg.

- `preview` and `final`: the two frame sizes. A final render of one language should take under 5 minutes.
- `fps.anim` and `fps.out`: the pose rate (12) and the video rate (24).
- `encoders`: tried in order; `h264_amf` is the AMD hardware encoder, `libx264` the CPU fallback.
- `loudness`: the mix is normalised to this target.
- `mix`: the levels relative to the voice (voices are brought to `voiceLufs`; music `musicGapUnderVoiceDb` under in the gaps and `musicUnderVoiceDb` under while a voice plays; sfx and clip audio `sfxUnderVoiceDb` / `clipUnderVoiceDb` under). A script's music `gain` is only a trim (at most 0 dB), never a boost. `minUnderVoiceDb` is the floor the mix check lints against.
