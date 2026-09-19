const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

test('Prosper cinematic runner validates assets and creates a no-cost resumable manifest', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'prosper-cinematic-'));
  const keyframes = join(fixture, 'keyframes');
  require('node:fs').mkdirSync(keyframes);
  const source = join(fixture, 'IMG_4670.jpeg');
  writeFileSync(source, 'source');
  for (const file of [
    '01-battery-solar-hero.png', '02-aerial-house.png', '03-neighborhood.png', '04-virginia-city.png',
    '05-earth-limb.png', '06-earth-moon.png', '07-sun-approach.png', '08-solar-flare.png'
  ]) writeFileSync(join(keyframes, file), file);
  const runDir = join(fixture, 'run');
  const result = spawnSync(process.execPath, ['scripts/prosper-solar-cinematic.mjs', '--source', source, '--keyframes-dir', keyframes, '--run-dir', runDir], {
    cwd: join(__dirname, '..'), encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No provider request was sent/);
  const state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.equal(state.backend, 'seedance-2.5-first-last-frame-480p');
  assert.deepEqual(Object.keys(state.clips), ['clip-a-house', 'clip-b-earth', 'clip-c-sun']);
  assert.equal(state.clips['clip-a-house'].status, 'prepared');
  rmSync(fixture, { recursive: true, force: true });
});

test('Prosper cinematic runner concatenates three completed clips', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'prosper-cinematic-assemble-'));
  const outputDir = join(fixture, 'outputs');
  require('node:fs').mkdirSync(outputDir);
  const clips = ['clip-a-house', 'clip-b-earth', 'clip-c-sun'].map((id, index) => {
    const file = join(outputDir, `${id}.mp4`);
    const made = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${['red', 'green', 'blue'][index]}:s=540x960:d=0.1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    return file;
  });
  const state = { clips: Object.fromEntries(['clip-a-house', 'clip-b-earth', 'clip-c-sun'].map((id, index) => [id, { status: 'completed', file: clips[index] }])) };
  writeFileSync(join(fixture, 'run.json'), JSON.stringify(state));
  const assembled = spawnSync(process.execPath, ['scripts/prosper-solar-cinematic.mjs', '--assemble', fixture], { cwd: join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(assembled.status, 0, assembled.stderr);
  assert.ok(existsSync(join(outputDir, 'prosper-solar-cinematic-9x16.mp4')));
  rmSync(fixture, { recursive: true, force: true });
});
