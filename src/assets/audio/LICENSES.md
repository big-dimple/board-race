# Audio Assets

## Board Race Rock

- Source: project-owner supplied full-length master (`1.mp3`)
- Rights/provenance: supplied and approved by the project owner for this project;
  no external license claim is made by this repository.
- Source SHA-256: `f9f0db2907df581bcedfc2ae15b0fbb42622d6e2d0ecfae2b43dbad74b384839`
- Integrated: 2026-08-12
- Modifications: complete 127.3 second arrangement retained; decoded around the
  malformed source tail frame, attenuated by 6dB, and re-encoded without clipping.
- Runtime safety: the complete game mix passes through a 48Hz high-pass and
  16:1 dynamics limiter before reaching the output device.
- Delivered formats: Ogg Vorbis and MP3 compatibility fallback.
- Playback: the first GO starts at the song opening; later runs preserve the
  same media position, and looping occurs only after the complete song ends.
