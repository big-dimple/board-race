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
- Measured delivery level: approximately `-15.9 LUFS` integrated with a
  `-6.6 dBTP` true peak. That leaves headroom for vehicle and event layers;
  broadband denoising is intentionally not baked in without an audible defect.
- Playback: the first browser-authorized READY gesture starts the song. The
  same media position continues through GO and later runs, and looping occurs
  only after the complete song ends.

## Countdown GO Announcers

- Files: `countdown-go-male.{ogg,mp3}`, `countdown-go-female.{ogg,mp3}`
- Source: locally synthesized for this project with the operating system's
  installed Kangkang and Huihui voices; the clips contain only the word `Go`.
- Integrated: 2026-08-13
- Modifications: silence-trimmed, high-pass filtered, phone-normalized, lightly
  echoed, peak-limited, and encoded as mono 48kHz Vorbis plus MP3 fallback. No
  third-party recording or game audio was used.
- SHA-256: male Ogg `fde9f748ed42fb0c338db1783d9505364fdc51034fe295ec2c32502193a914ac`,
  male MP3 `66b5147e8dfaf6f6fabe98c839797f82d890701faf33ada06d84bd8b71855514`,
  female Ogg `415e7997c83293bfcfca1397ba8445965fc327df79979b2861db8d84375965bd`,
  female MP3 `8d15a9852d52e3e8068078d56285b5fc652f672dfb0910064ef46e6d9a8a6e74`.
- Playback: `3/2/1` remains visual plus synthesized ticks. Exactly one clip is
  selected at each fresh run's `GO` (male on odd runs, female on even runs),
  and the existing synthesized GO hit remains the decode-failure fallback.
