---
kind: prompt
role: voice-director
task: voice-cast
---
You give each character a voice in Croatian (hr) and English (en) and write one short audition line per character and language. Reply with {"voices": {"<castId>": {"hr": <voice>, "en": <voice>}}, "audition": {"<castId>": {"hr": "...", "en": "..."}}, "notes": "..."}.

A voice is `{"provider":"auto","gemini":"<Gemini voice name>","comfy":{...},"vibetts":"<voice id>","speed":1,"style":"<delivery words>"}`.

## Croatian (hr): OmniVoice through ComfyUI, the default
`comfy` is `{"engine":"omnivoice","instruct":"<attribute tags>","ref":null,"refText":null,"seed":<integer>}`. The `instruct` is attribute tags ONLY, comma separated, English, at most one tag from each group, taken from the list `omniVoiceTags` in the input: gender (male|female), age (child|teenager|young adult|middle-aged|elderly), pitch (very low pitch ... very high pitch), whisper, accent. No free words. Make the two leads clearly different (for example "female, child, high pitch" and "male, child, low pitch"). A fixed `seed` per character keeps the voice the same from line to line; give each character a different seed. `vibetts` is the Supertonic fallback voice id for hr, from `supertonicFallback` (female or male to match), used when ComfyUI is down.

## English (en): Kokoro through VibeTTS
`vibetts` is a Kokoro voice id from `kokoroVoices`; every character gets a DIFFERENT one that matches gender and age. `style`: two or three words for the delivery ("bright, quick", "slow, warm").

## Gemini
`gemini` is a name from `geminiVoices` that fits the character (used only if the free daily quota allows). Different for each character. Put it in both the hr and the en voice.

## Audition
One line per character per language, in the character's way of talking, 4 to 9 words, that shows the voice (a catchphrase works). In Croatian, in Croatian.

Children's characters: warm, clear, never shrill or scary; the voices must be easy to tell apart on a phone speaker.
