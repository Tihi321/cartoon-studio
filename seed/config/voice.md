---
kind: voice
# The clip format: wav (lossless, what the mix wants) or mp3 (small).
format: wav
# Speech speed, 0.5 to 2, for the engines that take one (OmniVoice, F5-TTS).
speed: 1
# A long line is split for the TTS node after this many characters (100-1000).
chunkChars: 400
# Google's free Gemini TTS allows this many requests a day (every flow_narrate call that reaches Gemini counts, a retry too).
geminiDailyLimit: 10
# The day of that counter ends at midnight in this time zone (Google resets the free tier at Pacific midnight).
geminiResetTz: America/Los_Angeles
# The local voice chain per language, first one first. comfy = OmniVoice through ComfyUI, vibetts = the VibeTTS app
# (Supertonic reads Croatian, Kokoro reads English). Croatian goes to OmniVoice first, English to Kokoro first.
localOrder:
  hr: [comfy, vibetts]
  en: [vibetts, comfy]
# The default local ComfyUI engine (reads Croatian).
engine: omnivoice
---
# Voice

How the spoken lines are made. The lines of an episode are made by three providers: Google's free **Gemini** voices (through flow-music-mcp), **VibeTTS** (the local tray app: Kokoro, Supertonic, Higgs) and the local ComfyUI **TTS Audio Suite** engines (OmniVoice). Which one speaks is decided by the hub's voice rule below, unless a character forces one with its voice `provider` (`auto` is the default; `gemini`, `vibetts`, `comfy`).

## The hub's voice rule

- Gemini's free tier allows `geminiDailyLimit` requests a day (10). Cartoon Studio counts every request that reaches Gemini (a retry too) in `state/gemini-tts.json` (`{day, used}`); the day ends at midnight of `geminiResetTz`. A quota error from Google sets today's count to the limit.
- `remaining = limit - used`. Languages are allocated whole (a language never mixes providers in one run), **Croatian first**: if the lines of a language that need speaking fit in what is left, that language goes to Gemini, else it goes local. So when Croatian and English are both needed and together exceed what is left, Croatian goes to Gemini and English to the local voices. A line whose text, language, voice and style did not change is not spoken again.
- A pilot episode has 12 to 16 lines per language, which never fit in 10 requests, so both languages go local.

## The local chain

- `localOrder` is the chain per language. This differs from Edu Studio, which always tried VibeTTS first: **Croatian is OmniVoice first** (the user listened to samples; measured about twice real time on a warm model), Supertonic through VibeTTS is the Croatian fallback; **English is Kokoro first**, OmniVoice the fallback. When the first provider is down the next one takes over; when nothing can speak, the line gets a silent placeholder of the estimated length and a warning, never a failed run.
- OmniVoice reads its `instruct` as attribute tags (gender, age, pitch and the like), not free style words. A character's voice is therefore its attribute tags plus an optional reference clip (`ref` and its transcript), kept per character per language in the series bible.
- Licences: check each model card before using a series commercially.

## Fields

- `format`, `speed`, `chunkChars`: the clip format, the speech speed, and where a long line is split.
- `geminiDailyLimit`, `geminiResetTz`: the free quota and the time zone of its day.
- `localOrder`: see above. `engine`: the default ComfyUI engine id.

Paid voice providers sit behind the budget gate in `config/budget.md` (`voice.paidMaxUsd`, 0 here). No paid voice client exists.
