# YouTube Guitar Practice Assistant

Chrome extension that adds practice-focused controls to YouTube videos: speed control, pitch transpose, A–B looping, speed ramp, and a pop-out controller.

## Features

- **Speed control (0–200%)** with pitch preserved (time-stretch)
- **Pitch transpose (-12 to +12 semitones)** without changing video speed
- **A↔B loop**: set loop points A and B, toggle loop, clear loop, jump to A/B
- **Speed ramp**: increase speed by a step every N loops (up to a max)
- **Player controls**: restart, play/pause, +10s
- **Pop-out widget**: keep controls visible on the page while you practice

## Supported sites
- `https://www.youtube.com/*`
- `https://m.youtube.com/*`
- `https://music.youtube.com/*`


## Known limitations
- Some videos/pages may restrict audio processing (e.g., DRM/protected playback), which can prevent transpose from working.
- YouTube UI/DOM changes may occasionally require updates to video detection.

## Support
- Website: https://eeriegoesd.com/
