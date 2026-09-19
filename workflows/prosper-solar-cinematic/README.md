# Prosper solar and battery cinematic

This is a repeatable three-clip image-to-video workflow for the real Prosper house photograph. It deliberately uses separate 9:16 keyframes rather than a stacked storyboard or a one-shot generation.

## Inputs

Place Craig-approved, standalone images in `keyframes/` using every filename in `preset.json`. The source house image is supplied separately with `--source`. Do not replace a missing source image with a generated house.

The runner uses these continuity boundaries:

| Clip | First frame | Last frame |
| --- | --- | --- |
| A — house | original house/battery source | `02-aerial-house.png` |
| B — Earth | `02-aerial-house.png` | `06-earth-moon.png` |
| C — Sun | `06-earth-moon.png` | `08-solar-flare.png` |

The other four frames are explicit visual-review gates, so the intended Virginia and orbital stages are approved as individual stills before paid video work.

## Commands

First create a no-cost manifest and validate the assets:

```bash
node scripts/prosper-solar-cinematic.mjs \
  --source /absolute/path/IMG_4670.jpeg \
  --keyframes-dir workflows/prosper-solar-cinematic/keyframes \
  --quality preview
```

Render a low-resolution proof after setting `MUAPI_API_KEY` in the shell (never commit it):

```bash
MUAPI_API_KEY='...' node scripts/prosper-solar-cinematic.mjs \
  --execute --quality preview \
  --source /absolute/path/IMG_4670.jpeg \
  --keyframes-dir workflows/prosper-solar-cinematic/keyframes
```

For an approved 1080p render, change `--quality` to `final`. The runner records uploads, request IDs, polling results, downloaded clips, and the assembled MP4 under `.prosper-video-runs/`. Resume an interrupted run without paying for completed clips:

```bash
MUAPI_API_KEY='...' node scripts/prosper-solar-cinematic.mjs --execute --resume /absolute/path/to/run
```

The generated final is `outputs/prosper-solar-cinematic-9x16.mp4` in that run directory. `ffmpeg` is required only for final assembly.

## Backend and safety

Preview uses `seedance-2.5-first-last-frame-480p`; final uses `seedance-2.5-first-last-frame-1080p`. Both are currently wired in the Studio catalog and accept exactly two `images_list` inputs. The runner does not create paid jobs unless `--execute` is supplied, and it never writes the API key into state or logs.

The local Wan2GP route belongs to the Electron desktop client, not the deployed web app. It remains a separate GPU-server fallback; see the repository's Local Models settings after the cloud proof is complete.
