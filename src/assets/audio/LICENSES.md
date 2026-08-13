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

## Countdown GO Announcers

- Files: `countdown-go-male.ogg`, `countdown-go-female.ogg`
- Source: locally synthesized for this project with the operating system's
  installed Kangkang and Huihui voices; the clips contain only the word `Go`.
- Integrated: 2026-08-13
- Modifications: silence-trimmed, high-pass filtered, peak-limited, and encoded
  as mono Ogg Vorbis at 48kHz. No third-party recording or game audio was used.
- SHA-256: male `97b1b0134825d31e25b6cfd36a44b57d1fb7bfb39411b994ab7c75bd09bead53`;
  female `8d1596731424825e1a8d1dfea0252588064ed08975fd41a097b5fb5fea71539e`.
- Playback: `3/2/1` remains visual plus synthesized ticks. Exactly one clip is
  selected at each fresh run's `GO` (male on odd runs, female on even runs),
  and the existing synthesized GO hit remains the decode-failure fallback.
