#!/usr/bin/env node

/**
 * Repeatable three-clip Seedance 2.5 runner for the Prosper solar cinematic.
 * The runner is intentionally API-key-free at rest: MUAPI_API_KEY is read only
 * from the process environment when --execute is explicit.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PRESET = join(ROOT, 'workflows/prosper-solar-cinematic/preset.json');
const API_BASE = 'https://api.muapi.ai';
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 900;
const SUCCESS = new Set(['completed', 'succeeded', 'success']);
const FAILURE = new Set(['failed', 'error', 'cancelled', 'canceled']);

const PROMPTS = {
  'clip-a-house': `CINEMATIC PHOTOREAL VERTICAL COMMERCIAL FILM, 9:16. Start exactly from the supplied real brick suburban home with the white outdoor wall-mounted batteries. Preserve its brick architecture, windows, conduits, electrical boxes, battery count, battery placement, landscaping, and realistic residential scale. Golden-hour Virginia sunlight. Begin close on the white batteries with a subtle low-angle premium push-in; pull backward and upward to reveal sleek BLACK-ON-BLACK rooftop solar. Continue into a professional drone orbit around the full home and neighborhood with physically believable FAST to SLOW to FAST to SLOW speed ramping, then climb into the aerial final frame. No blue panels, text, logos, UI, captions, arrows, HUD, people, duplicated batteries, warped roof, or CGI styling.`,
  'clip-b-earth': `CINEMATIC PHOTOREAL VERTICAL COMMERCIAL FILM, 9:16. Continue seamlessly from the supplied aerial house frame. Rise continuously from the believable Virginia neighborhood through a tree-lined Virginia city, roads, rivers, and golden-hour haze. Accelerate upward: city becomes eastern United States, cloud systems appear, then pass through the atmosphere into a magnificent realistic orbital Earth view. End with Earth and a detailed Moon at the supplied final frame. Preserve geographic continuity and realistic scale. No labels, text, captions, logos, UI, HUD, fantasy nebulae, random people, or hard cuts.`,
  'clip-c-sun': `CINEMATIC PHOTOREAL VERTICAL COMMERCIAL FILM, 9:16. Continue seamlessly from the supplied Earth and Moon frame. Earth recedes into deep black space with subtle stars; pass near the realistic detailed Moon and change direction toward the Sun. Use enormous but physically believable scale and cinematic motion blur. Speed ramp FAST to SLOW as the Sun fills frame, then FAST on final approach. End inside an ultra-photoreal solar surface with coronal loops, turbulent plasma, solar flares, and gold-orange-yellow-white light matching the supplied final frame. No text, captions, logos, UI, HUD, blue graphics, fantasy elements, or hard cuts.`
};

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
  return null;
}

function usage() {
  return `Usage: node scripts/prosper-solar-cinematic.mjs --source <IMG_4670.jpeg> --keyframes-dir <dir> [--quality preview|final] [--execute --approve-cost] [--run-dir <dir>] [--resume <run-dir>] [--assemble <run-dir>]\n`;
}

function parseArgs(argv) {
  const options = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--approve-cost') options.approveCost = true;
    else if (arg === '--source' || arg === '--keyframes-dir' || arg === '--quality' || arg === '--run-dir' || arg === '--resume' || arg === '--assemble') {
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function absolute(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function dateStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function redactedError(error) {
  return String(error?.message || error).replaceAll(process.env.MUAPI_API_KEY || '__no_key__', '[redacted]');
}

function requiredAssets(source, keyframesDir, preset) {
  return [
    { id: 'source', path: source },
    ...preset.keyframes.map(({ file }) => ({ id: file, path: join(keyframesDir, file) }))
  ];
}

function validateAssets(source, keyframesDir, preset) {
  const missing = requiredAssets(source, keyframesDir, preset).filter(({ path }) => !existsSync(path));
  if (missing.length) throw new Error(`Missing required standalone source/keyframes:\n${missing.map(({ id, path }) => `- ${id}: ${path}`).join('\n')}`);
}

function initialState({ presetPath, source, keyframesDir, quality }) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    presetPath,
    source,
    keyframesDir,
    quality,
    aspectRatio: '9:16',
    backend: quality === 'final' ? 'seedance-2.5-first-last-frame-1080p' : 'seedance-2.5-first-last-frame-480p',
    clips: Object.fromEntries(Object.keys(PROMPTS).map((id) => [id, { status: 'prepared' }]))
  };
}

function requestHeaders(key) {
  return { 'content-type': 'application/json', 'x-api-key': key };
}

async function checkedFetch(url, options, key) {
  const response = await fetch(url, options);
  if (response.ok) return response;
  const detail = (await response.text()).slice(0, 500).replaceAll(key, '[redacted]');
  throw new Error(`${options?.method || 'GET'} ${url} failed: ${response.status} ${detail}`);
}

async function uploadFile(apiKey, path) {
  const bytes = readFileSync(path);
  const form = new FormData();
  form.append('file', new Blob([bytes]), basename(path));
  const response = await checkedFetch(`${API_BASE}/api/v1/upload_file`, {
    method: 'POST', headers: { 'x-api-key': apiKey }, body: form
  }, apiKey);
  const result = await response.json();
  const url = result.url || result.file_url || result.data?.url;
  if (!url) throw new Error(`Upload returned no file URL for ${basename(path)}`);
  return url;
}

async function submitClip(apiKey, endpoint, payload) {
  const response = await checkedFetch(`${API_BASE}/api/v1/${endpoint}`, {
    method: 'POST', headers: requestHeaders(apiKey), body: JSON.stringify(payload)
  }, apiKey);
  const result = await response.json();
  const requestId = result.request_id || result.id;
  if (!requestId) throw new Error(`Submission returned no request ID: ${JSON.stringify(result).slice(0, 500)}`);
  return { requestId, submitted: result };
}

async function estimateClipCost(endpoint, payload) {
  const response = await checkedFetch(`${API_BASE}/api/v1/models/${endpoint}/estimate-cost`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  }, '');
  const estimate = await response.json();
  if (!Number.isFinite(estimate?.cost) || estimate.cost < 0 || typeof estimate?.currency !== 'string') {
    throw new Error(`Cost estimate returned an invalid response: ${JSON.stringify(estimate).slice(0, 500)}`);
  }
  return { cost: estimate.cost, currency: estimate.currency, dynamicPricing: Boolean(estimate.dynamic_pricing), estimatedAt: new Date().toISOString() };
}

async function pollClip(apiKey, requestId) {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS));
    const response = await checkedFetch(`${API_BASE}/api/v1/predictions/${requestId}/result`, {
      headers: { 'x-api-key': apiKey }
    }, apiKey);
    const result = await response.json();
    const status = String(result.status || '').toLowerCase();
    if (SUCCESS.has(status)) return result;
    if (FAILURE.has(status)) throw new Error(`Generation ${requestId} failed: ${result.error?.message || result.error || result.message || 'unknown provider error'}`);
  }
  throw new Error(`Generation ${requestId} timed out after ${MAX_POLL_ATTEMPTS} polls`);
}

function outputUrl(result) {
  const url = result.outputs?.[0] || result.url || result.output?.url;
  if (!url) throw new Error(`Generation completed without a video URL: ${JSON.stringify(result).slice(0, 500)}`);
  return url;
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', rejectRun);
    child.on('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with ${code}`)));
  });
}

async function assemble(runDir, state) {
  const outputDir = join(runDir, 'outputs');
  const clips = Object.values(state.clips).map(({ file }) => file).filter(Boolean);
  if (clips.length !== 3 || clips.some((file) => !existsSync(file))) throw new Error('All three downloaded clip files are required before assembly.');
  const listPath = join(outputDir, 'concat.txt');
  writeFileSync(listPath, clips.map((file) => `file '${file.replaceAll("'", "'\\\\''")}'`).join('\n') + '\n');
  const finalPath = join(outputDir, 'prosper-solar-cinematic-9x16.mp4');
  try {
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalPath]);
  } catch {
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', finalPath]);
  }
  state.assembledAt = new Date().toISOString();
  state.finalVideo = finalPath;
  return finalPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return process.stdout.write(usage());
  if (options.assemble) {
    const runDir = absolute(options.assemble);
    const statePath = join(runDir, 'run.json');
    if (!existsSync(statePath)) throw new Error(`No run state: ${statePath}`);
    const state = readJson(statePath);
    const finalVideo = await assemble(runDir, state);
    writeJson(statePath, state);
    return process.stdout.write(`Assembled ${finalVideo}\n`);
  }

  const presetPath = DEFAULT_PRESET;
  const preset = readJson(presetPath);
  const runDir = options.resume ? absolute(options.resume) : options.runDir ? absolute(options.runDir) : join(ROOT, '.prosper-video-runs', dateStamp());
  const statePath = join(runDir, 'run.json');
  const resumedState = options.resume && existsSync(statePath) ? readJson(statePath) : null;
  const source = options.source ? absolute(options.source) : resumedState?.source || null;
  const keyframesDir = options.keyframesDir ? absolute(options.keyframesDir) : resumedState?.keyframesDir || join(ROOT, 'workflows/prosper-solar-cinematic/keyframes');
  const quality = options.quality || resumedState?.quality || 'preview';
  if (!source) throw new Error('--source is required.');
  if (!['preview', 'final'].includes(quality)) throw new Error('--quality must be preview or final.');
  validateAssets(source, keyframesDir, preset);

  const state = resumedState || initialState({ presetPath, source, keyframesDir, quality });
  mkdirSync(join(runDir, 'jobs'), { recursive: true });
  mkdirSync(join(runDir, 'outputs'), { recursive: true });
  writeJson(statePath, state);

  if (!options.execute) {
    process.stdout.write(`Prepared ${runDir}\nNo provider request was sent. Re-run with --execute after reviewing cost and setting MUAPI_API_KEY.\n`);
    return;
  }
  const apiKey = process.env.MUAPI_API_KEY;
  if (!apiKey) throw new Error('MUAPI_API_KEY is required with --execute.');
  const endpoint = state.backend;
  const files = { source };
  for (const { file } of preset.keyframes) files[file] = join(keyframesDir, file);
  state.uploads ||= {};
  for (const [id, path] of Object.entries(files)) {
    if (!state.uploads[id]) {
      process.stdout.write(`Uploading ${id}\n`);
      state.uploads[id] = await uploadFile(apiKey, path);
      writeJson(statePath, state);
    }
  }

  const plans = preset.clips.map((clip) => {
    const firstUrl = state.uploads[clip.firstFrame];
    const lastUrl = state.uploads[clip.lastFrame];
    return {
      clip,
      payload: { prompt: PROMPTS[clip.id], images_list: [firstUrl, lastUrl], aspect_ratio: '9:16', duration: state.quality === 'final' ? 12 : 5, high_bitrate: state.quality === 'final' }
    };
  });
  state.costEstimates ||= {};
  for (const { clip, payload } of plans) {
    if (!state.costEstimates[clip.id]) state.costEstimates[clip.id] = await estimateClipCost(endpoint, payload);
  }
  const estimates = Object.values(state.costEstimates);
  const currencies = new Set(estimates.map(({ currency }) => currency));
  state.estimatedTotal = currencies.size === 1
    ? { cost: estimates.reduce((total, { cost }) => total + cost, 0), currency: estimates[0]?.currency, dynamicPricing: estimates.some(({ dynamicPricing }) => dynamicPricing) }
    : null;
  writeJson(statePath, state);
  if (!options.approveCost) {
    const total = state.estimatedTotal ? `${state.estimatedTotal.cost.toFixed(2)} ${state.estimatedTotal.currency}` : 'multiple currencies';
    process.stdout.write(`Estimated provider total: ${total}. No generation was submitted. Re-run with --execute --approve-cost only after approving this dynamic estimate.\n`);
    return;
  }

  for (const { clip, payload } of plans) {
    const clipState = state.clips[clip.id] ||= { status: 'prepared' };
    if (clipState.status === 'completed' && clipState.file && existsSync(clipState.file)) continue;
    if (!clipState.requestId) {
      const submitted = await submitClip(apiKey, endpoint, payload);
      Object.assign(clipState, submitted, { status: 'submitted', payload });
      writeJson(join(runDir, 'jobs', `${clip.id}.json`), clipState);
      writeJson(statePath, state);
      process.stdout.write(`Submitted ${clip.id}: ${submitted.requestId}\n`);
    }
    const result = await pollClip(apiKey, clipState.requestId);
    const url = outputUrl(result);
    const file = join(runDir, 'outputs', `${clip.id}.mp4`);
    await download(url, file);
    Object.assign(clipState, { status: 'completed', completedAt: new Date().toISOString(), result, url, file });
    writeJson(join(runDir, 'jobs', `${clip.id}.json`), clipState);
    writeJson(statePath, state);
    process.stdout.write(`Completed ${clip.id}: ${file}\n`);
  }
  const finalVideo = await assemble(runDir, state);
  writeJson(statePath, state);
  process.stdout.write(`Final video: ${finalVideo}\n`);
}

main().catch((error) => fail(redactedError(error)));
