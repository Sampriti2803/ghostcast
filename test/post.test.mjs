import { test } from 'node:test';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { segments, smooth, view_track, box_at, windows, speed_tag, beat_plan, captionPieces, transitionPlan } from '../src/post/logic.mjs';
import { runs, perspectiveExpressions, balancedSum, beatCacheKey, cut as renderCut, assemble as renderAssemble, ffmpeg, ffmpegStderr, pill } from '../src/post/render.mjs';
import { directCamera, fitSegment, fitTargets, motionIntervals, readingSeconds } from '../src/post/fit.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectors');
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const cfg = read('config'), cut = read('cut'), assemble = read('assemble');
const fit = read('fit');
function close(got, want) {
  if (Array.isArray(want)) { assert.equal(got.length, want.length); want.forEach((v, i) => close(got[i], v)); }
  else if (typeof want === 'number') assert.ok(Math.abs(got - want) < 1e-6, `${got} != ${want}`);
  else assert.deepEqual(got, want);
}
for (const c of cut.segments) test(`segments: ${c.name}`, () => close(segments(c.log), c.expected));
test('smooth vectors', () => { for (const [k, v] of cut.smooth) close(smooth(k), v); });
for (const c of cut.view_track) test(`view_track: ${c.name}`, () => close(view_track(c.log, ...c.src, c.dpr, cfg), c.expected));
for (const c of cut.box_at) test(`box_at: ${c.name}`, () => { for (const [t, v] of c.samples) close(box_at(c.keys, t), v); });
for (const c of assemble.windows) test(`windows: ${c.name}`, () => close(windows(c.item, c.meta), c.expected));

test('windows: a capped caption ends with its segment or at its cap, whichever is first', () => {
  const meta = { duration: 12, segments: [{ segment: 'long', start: 0, end: 10 }, { segment: 'short', start: 10, end: 12 }] };
  const item = { take: 't', captions: [{ text: 'Long', from: 'long', at: .3, until: 'end', max: 7.5 }, { text: 'Short', from: 'short', at: .3, until: 'end', max: 7.5 }] };
  close(windows(item, meta), [['Long', .3, 7.8, 'bottom'], ['Short', 10.3, 12, 'bottom']]);
});
for (const c of assemble.windows_errors) test(`windows error: ${c.name}`, () => assert.throws(() => windows(c.item, c.meta)));
test('speed_tag vectors', () => { for (const [s, tag] of assemble.speed_tag) assert.equal(speed_tag(s), tag); });
test('tick count rounds half frames to even as Python does', () => {
  const c = { ...cfg, trims: { first: 2.5 / 30 } };
  const p = beat_plan([[200, '+first'], [1000, '-first']], [[0, 'frame.jpg']], c, 320, 180);
  assert.equal(p.beats[0].ticks.length, 2);
});
test('a caption spanning beats fades only at its own ends', () => {
  const caps = [['hello', .3, 2.2, 'bottom']];
  const pieces = [[0, 1], [1, 2], [2, 3]].map(([start, end]) => captionPieces(caps, { start, end })[0]);
  assert.deepEqual(pieces.map((p) => [p.fadeIn, p.fadeOut]), [[true, false], [false, false], [false, true]]);
  close(pieces.map((p) => [p.a, p.b]), [[.3, 1], [0, 1], [0, .2]]);
});

for (const c of fit.cases) test(`fitSegment: ${c.name}`, () => {
  const result = fitSegment(c);
  for (const key of ['natural', 'output', 'removed', 'speed', 'overrun', 'shortfall']) close(result[key], c[key]);
  const gaps = result.pieces.slice(1).map((p, i) => [result.pieces[i].b, p.a]).filter(([a, b]) => b - a > 1e-8);
  close(gaps.reduce((sum, [a, b]) => sum + b - a, 0), result.removed);
  for (const [a, b] of gaps) {
    const still = c.still.find((s) => a >= s.a && b <= s.b);
    assert.ok(still, `cut ${a}–${b} must be in stillness`);
    assert.ok(a - still.a >= .15 - 1e-8 && still.b - b >= .15 - 1e-8);
  }
  const protectedStill = c.still.find((s) => s.postFraming);
  if (protectedStill) {
    const retained = result.pieces.reduce((sum, p) => sum + Math.max(0,
      Math.min(p.b, protectedStill.b) - Math.max(p.a, protectedStill.a)), 0);
    assert.ok(retained >= Math.max(1.5, c.reading) - 1e-8);
  }
});

test('fitTargets reads only a storyboard take and counts say and show words', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-targets-'));
  try {
    fs.writeFileSync(path.join(root, 'product.md'), '# Product\n');
    fs.writeFileSync(path.join(root, 'storyboard.yaml'), 'beats:\n  - id: claim\n    say: "One two three four five"\n');
    const log = [[200, '+claim'], [1000, 'show', { text: 'Read these three words', rect: {} }], [3000, '-claim']];
    const result = fitTargets(root, 'storyboard', log, { voiceover: { wordsPerSecond: 2.5 } });
    close(result.targets.claim, 2.6);
    close(result.readings.claim, .5 + 4 / 3);
    fs.writeFileSync(path.join(root, 'storyboard.yaml'), 'beats:\n  - id: claim\n    say: "One"\n');
    close(fitTargets(root, 'storyboard', log, { voiceover: { wordsPerSecond: 2.5 } }).targets.claim, 2);
    assert.deepEqual(fitTargets(root, 'other', log, cfg), { targets: {}, readings: {} });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fitted targets never cut a move or jump the camera at either target', () => {
  const log = [[200, '+claim'], [2000, 'focus', { x: 80, y: 40, w: 60, h: 40 }],
    [2000, 'hold', { beat: 'claim' }], [2700, 'show', { text: 'a result', rect: {} }],
    [9000, 'holdend'], [9650, '-claim']];
  for (const target of [7, 4]) {
    const plan = beat_plan(log, [[0, 'frame.jpg']], { ...cfg, output: { fps: 30 }, zoom: { max: 2 } }, 320, 180,
      { targets: { claim: target }, readings: { claim: 1.2 } });
    const moving = motionIntervals(segments(log)[0], directCamera(log, { zoom: { max: 2 } }, 320, 180, 1)).moving;
    for (let i = 1; i < plan.beats.length; i++) {
      const a = plan.beats[i - 1].b, b = plan.beats[i].a;
      if (b - a < 1e-8) continue;
      assert.ok(moving.every((m) => b <= m.a || a >= m.b), `cut ${a}–${b} overlaps motion`);
      close(box_at(plan.keys, a), box_at(plan.keys, b));
    }
    assert.ok(plan.meta.segments[0].fit);
  }
});

test('motion intervals include margins and holds but exclude camera easing', () => {
  const log = [[200, '+claim'], [2000, 'focus', { x: 80, y: 40, w: 60, h: 40 }],
    [2000, 'hold', { beat: 'claim' }], [9000, 'holdend'], [9650, '-claim']];
  const { still, moving } = motionIntervals(segments(log)[0], log);
  close(still.map((s) => [s.a, s.b]), [[0, .2], [2.75, 9], [9.65, 10]]);
  close(moving.map((s) => [s.a, s.b]), [[.2, 2.75], [9, 9.65]]);
  assert.equal(still[1].postFraming, true);
});

test('speed tags cover only fast fitted pieces', () => {
  const log = [[200, '+claim'], [500, 'hold', { beat: 'claim' }], [1000, 'holdend'], [9650, '-claim']];
  const plan = beat_plan(log, [[0, 'frame.jpg']], { ...cfg, output: { fps: 30 } }, 320, 180,
    { targets: { claim: 4 } });
  const segment = plan.meta.segments[0];
  assert.ok(segment.pieces.some((p) => p.speed >= 1.5));
  close(windows({ take: 'storyboard' }, plan.meta), segment.pieces.filter((p) => p.speed >= 1.5)
    .map((p) => [speed_tag(p.speed), p.start, p.end, 'corner']));
  assert.ok(segment.pieces.some((p) => p.speed === 1));
});

test('directCamera removes low gain, merges close returns, and caps moves', () => {
  const conf = { zoom: { max: 3 }, direction: { minHold: 0, movesPerMinute: 2 } };
  const low = [[0, 'hold'], [1000, 'focus', { x: 0, y: 0, w: 300, h: 160 }], [4000, 'unfocus']];
  assert.deepEqual(directCamera(low, conf, 320, 180, 1).map((e) => e[1]), ['hold']);
  const closeReturn = [[0, 'hold'], [1000, 'focus', { x: 30, y: 20, w: 60, h: 30 }],
    [5000, 'unfocus'], [5200, 'focus', { x: 60, y: 30, w: 50, h: 30 }]];
  assert.deepEqual(directCamera(closeReturn, { ...conf, direction: { ...conf.direction, movesPerMinute: 12 } }, 320, 180, 1)
    .map((e) => e[1]), ['hold', 'focus', 'focus']);
  const log = [[0, 'hold'], ...[1.3, 2, 2.5, 3].map((zoom, i) => [i * 10000 + 1000, 'focus',
    { x: 30, y: 20, w: 40, h: 30, zoom }])];
  const retained = directCamera(log, conf, 320, 180, 1).filter((e) => e[1] === 'focus');
  assert.equal(retained.length, 2);
  assert.deepEqual(retained.map((e) => e[2].zoom), [2.5, 3]);
});

test('directCamera keeps a framing through a too-early unfocus or another focus', () => {
  const box = { x: 30, y: 20, w: 60, h: 30 };
  const conf = { zoom: { max: 2 } };
  const earlyReturn = [[0, 'hold'], [1000, 'focus', box], [2000, 'unfocus']];
  assert.deepEqual(directCamera(earlyReturn, conf, 320, 180, 1).map((e) => e[1]), ['hold', 'focus']);
  const earlyRefocus = [[0, 'hold'], [1000, 'focus', box], [2000, 'focus', box], [10000, 'focus', box]];
  assert.deepEqual(directCamera(earlyRefocus, conf, 320, 180, 1).map((e) => e[0]), [0, 2000, 10000]);
});

test('a hand-written segment ignores targets and keeps the original beat plan', () => {
  const log = [[200, '+one'], [1000, 'focus', { x: 40, y: 20, w: 80, h: 45 }], [3200, '-one']];
  const frames = [[0, 'frame.jpg']];
  assert.deepEqual(beat_plan(log, frames, cfg, 320, 180, { targets: { one: 2 } }),
    beat_plan(log, frames, cfg, 320, 180));
});

// A small evaluator for the ffmpeg expression subset emitted by perspectiveExpressions.
function compilePerspective(source) {
  const input = source.replace(/\\,/g, ',');
  const tokens = input.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_]+|[()+*/;,-]/gi);
  assert.equal(tokens.join(''), input.replace(/\s+/g, ''));
  let at = 0;
  const take = (v) => { if (tokens[at] !== v) throw new Error(`want ${v}, got ${tokens[at]}`); at++; };
  const primary = () => {
    const t = tokens[at++];
    if (t === '(') { const e = sequence(); take(')'); return e; }
    if (t === '-') return ['neg', primary()];
    if (/^(?:\d|\.)/.test(t)) return ['number', Number(t)];
    if (t === 'in') return ['input'];
    take('(');
    const args = [];
    if (tokens[at] !== ')') { args.push(sum()); while (tokens[at] === ',') { at++; args.push(sum()); } }
    take(')');
    return [t, ...args];
  };
  const product = () => { let e = primary(); while (tokens[at] === '*' || tokens[at] === '/') { const op = tokens[at++]; e = [op, e, primary()]; } return e; };
  const sum = () => { let e = product(); while (tokens[at] === '+' || tokens[at] === '-') { const op = tokens[at++]; e = [op, e, product()]; } return e; };
  // a;b;c runs each in order and is worth the last, at the top level or inside parentheses.
  const sequence = () => { const e = ['seq', sum()]; while (tokens[at] === ';') { at++; e.push(sum()); } return e.length === 2 ? e[1] : e; };
  const top = sequence();
  assert.equal(at, tokens.length);
  return (frame) => {
    const registers = [];
    const evaluate = (e) => {
      const v = (i) => evaluate(e[i]);
      switch (e[0]) {
        case 'number': return e[1]; case 'input': return frame; case 'neg': return -v(1);
        case '+': return v(1) + v(2); case '-': return v(1) - v(2);
        case '*': return v(1) * v(2); case '/': return v(1) / v(2);
        case 'clip': return Math.max(v(2), Math.min(v(3), v(1)));
        case 'gte': return Number(v(1) >= v(2));
        case 'between': return Number(v(1) >= v(2) && v(1) <= v(3));
        case 'st': { const index = v(1), value = v(2); registers[index] = value; return value; }
        case 'ld': return registers[v(1)] ?? 0;
        case 'seq': { let last; for (let i = 1; i < e.length; i++) last = v(i); return last; }
        default: throw new Error(`unknown operation ${e[0]}`);
      }
    };
    return evaluate(top);
  };
}

// How deep ffmpeg's parser nests an expression: a flat a+b+c… is as deep as it has terms.
function expressionDepth(source) {
  let depth = 0, deepest = 0, chain = 0;
  for (const token of source.replace(/\\,/g, ',').match(/[()+;]|[^()+;]+/g)) {
    if (token === '(') { depth++; chain = 0; } else if (token === ')') depth--;
    else if (token === '+' || token === ';') chain++;
    deepest = Math.max(deepest, depth + chain);
  }
  return deepest;
}

test('balancedSum keeps the value and the order of statements, at log depth', () => {
  for (const n of [1, 2, 3, 7, 100, 513]) {
    const terms = Array.from({ length: n }, (_, i) => String(i + 1));
    assert.equal(compilePerspective(balancedSum(terms))(0), n * (n + 1) / 2);
    assert.ok(expressionDepth(balancedSum(terms)) <= 2 * Math.ceil(Math.log2(n + 1)) + 1, `${n} terms`);
    // Each statement reads the one before it, so a reordering changes the result.
    const statements = terms.map((t, i) => `st(0\\,${i}-ld(0)*0.5)`).concat('ld(0)');
    const flat = compilePerspective(statements.join(';'))(0);
    assert.equal(compilePerspective(balancedSum(statements, ';'))(0), flat);
  }
  assert.equal(balancedSum([]), '0');
});

function cameraFixture(moves, start = 0) {
  const full = [0, 0, 320, 180], keys = [[-1e18, full]];
  for (let i = 0; i < moves; i++) keys.push([.5 + i * .18,
    i % 3 === 2 ? full : [20 + i % 5 * 8, 10 + i % 7 * 5, 220 + i % 3 * 10, 124 + i % 3 * 6]]);
  const fps = 30, end = .5 + moves * .18 + 1.5, count = Math.ceil((end - start) * fps);
  const ticks = Array.from({ length: count }, (_, i) => {
    const sourceTime = start + i / fps;
    return { file: 'frame.jpg', sourceTime, box: box_at(keys, sourceTime) };
  });
  return { keys, beat: { a: start, speed: 1, fps, ticks }, rs: runs(ticks) };
}

for (const moves of [1, 8, 50]) test(`perspective corners match box_at for ${moves} camera moves`, () => {
  const { keys, beat, rs } = cameraFixture(moves, moves === 1 ? 0 : moves === 8 ? 1.2 : 3);
  const evaluators = perspectiveExpressions(rs, beat, keys).map(compilePerspective);
  let tick = 0;
  for (let i = 0; i < rs.length; i++) {
    const got = evaluators.map((evaluate) => evaluate(i + 1));
    for (let j = 0; j < rs[i].count; j++, tick++) {
      const [x, y, w, h] = box_at(keys, beat.ticks[tick].sourceTime);
      close(got, [x, y, x + w, y + h]);
    }
  }
  assert.equal(tick, beat.ticks.length);
});

test('perspective expression size is linear for 50 moves and 500 runs', () => {
  const sizes = {};
  for (const moves of [2, 8, 50]) {
    const fixture = cameraFixture(moves);
    if (moves === 50) {
      fixture.rs = Array.from({ length: 500 }, (_, i) => ({ file: `f${i}.jpg`, box: [i % 2, 0, 220, 124], count: 2 }));
      fixture.beat.ticks = Array.from({ length: 1000 }, (_, i) => ({ sourceTime: i / 30 }));
    }
    sizes[moves] = Math.max(...perspectiveExpressions(fixture.rs, fixture.beat, fixture.keys).map((s) => s.length));
    assert.ok(sizes[moves] < 200_000, `${moves} moves: ${sizes[moves]} characters`);
  }
  console.log('perspective expression maximum characters by move count:', sizes);
});

test('ffmpeg renders a synthetic take with 20 camera moves at the planned frame count', { timeout: 120000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-camera-'));
  try {
    const raw = path.join(root, 'raw', 'moves'); fs.mkdirSync(path.join(raw, 'frames'), { recursive: true });
    const jpg = path.join(raw, 'frames', 'frame.jpg');
    const image = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=s=320x180:d=0.1', '-frames:v', '1', '-y', jpg], { encoding: 'utf8' });
    assert.equal(image.status, 0, image.stderr);
    const project = { name: 'moves', viewport: { width: 320, height: 180, dpr: 1 },
      output: { width: 320, height: 180, fps: 30 } };
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(project));
    fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify([[0, 'frame.jpg']]));
    const log = [[200, '+many']];
    for (let i = 0; i < 20; i++) log.push([300 + i * 180, i % 2 ? 'unfocus' : 'focus',
      { x: 40 + i % 4 * 12, y: 25, w: 80, h: 45 }]);
    log.push([4100, '-many']);
    fs.writeFileSync(path.join(raw, 'log.json'), JSON.stringify(log));
    const expected = beat_plan(log, [[0, 'frame.jpg']], project, 320, 180).beats[0].ticks.length;
    const cli = path.resolve(dir, '..', '..', 'bin', 'ghostcast.mjs');
    const render = spawnSync(process.execPath, [cli, 'cut', 'moves', '--project', root],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(render.status, 0, render.stdout + render.stderr);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0',
      path.join(root, 'clips', 'moves.mp4')], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(Number(probe.stdout.trim()), expected);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

// A long beat whose page changes every other tick has one repeated frame per run: summed flat,
// that timing made ffmpeg's perspective fail ("Cannot allocate memory") from about 95 terms.
test('ffmpeg renders a long zoomed hold of 120+ repeated frames after 41 camera moves', { timeout: 180000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-long-'));
  try {
    const raw = path.join(root, 'raw', 'long'); fs.mkdirSync(path.join(raw, 'frames'), { recursive: true });
    const first = path.join(raw, 'frames', 'f0.jpg');
    const image = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=s=320x180:d=0.1', '-frames:v', '1', '-y', first], { encoding: 'utf8' });
    assert.equal(image.status, 0, image.stderr);
    // A new frame every other tick for 14 s; 41 camera moves in the first 4 s, the last one a
    // zoom that then holds, so the hold's repeated frames all go through the warp.
    const frames = [];
    for (let i = 0; i < 212; i++) {
      if (i) fs.copyFileSync(first, path.join(raw, 'frames', `f${i}.jpg`));
      frames.push([0.2 + i * 0.066, `f${i}.jpg`]);
    }
    const project = { name: 'long', viewport: { width: 320, height: 180, dpr: 1 },
      output: { width: 320, height: 180, fps: 30 } };
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(project));
    fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify(frames));
    const log = [[200, '+long']];
    for (let i = 0; i < 41; i++) log.push([300 + i * 100, i % 2 ? 'unfocus' : 'focus',
      { x: 40 + i % 4 * 12, y: 25, w: 80, h: 45 }]);
    log.push([14200, '-long']);
    fs.writeFileSync(path.join(raw, 'log.json'), JSON.stringify(log));
    const plan = beat_plan(log, frames, project, 320, 180);
    const repeated = runs(plan.beats[0].ticks).filter((r) => r.count > 1).length;
    assert.ok(repeated > 120, `only ${repeated} repeated runs`);
    const cli = path.resolve(dir, '..', '..', 'bin', 'ghostcast.mjs');
    const render = spawnSync(process.execPath, [cli, 'cut', 'long', '--project', root],
      { encoding: 'utf8', timeout: 180000 });
    assert.equal(render.status, 0, render.stdout + render.stderr);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0',
      path.join(root, 'clips', 'long.mp4')], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(Number(probe.stdout.trim()), plan.beats.reduce((n, b) => n + b.ticks.length, 0));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('caption edits invalidate only covered beats; assemble joins exact beat duration', { timeout: 180000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-post-'));
  try {
    const raw = path.join(root, 'raw', 'demo', 'frames'); fs.mkdirSync(raw, { recursive: true });
    const jpg = path.join(raw, 'frame.jpg');
    const gen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=0.1', '-frames:v', '1', '-y', jpg], { encoding: 'utf8' });
    assert.equal(gen.status, 0, gen.stderr);
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name: 'demo', viewport: { width: 320, height: 180, dpr: 1 }, output: { width: 320, height: 180, fps: 30, capSeconds: 10 }, captions: { size: 18 } }));
    fs.writeFileSync(path.join(root, 'raw', 'demo', 'frames.json'), JSON.stringify([[0, 'frame.jpg']]));
    fs.writeFileSync(path.join(root, 'raw', 'demo', 'log.json'), JSON.stringify([
      [0, 'viewport', { w: 320, h: 180 }], [0, '+first'], [1000, '-first'],
      [1300, '+second'], [1600, 'focus', { x: 80, y: 40, w: 80, h: 50 }],
      [1800, 'focus', { x: 120, y: 60, w: 60, h: 40 }], [2100, 'unfocus'], [2300, '-second'],
    ]));
    const timeline = { items: [{ take: 'demo', captions: [{ text: 'First caption', from: 'first' }] }] };
    fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify(timeline));
    const cli = path.resolve(dir, '..', '..', 'bin', 'ghostcast.mjs');
    const gc = (...args) => {
      const r = spawnSync(process.execPath, [cli, ...args, '--project', root], { encoding: 'utf8', timeout: 120000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return r.stdout;
    };
    assert.equal((gc('cut', 'demo').match(/: rendered /g) ?? []).length, 2);
    assert.equal((gc('cut', 'demo').match(/: rendered /g) ?? []).length, 0);
    timeline.items[0].captions[0].text = 'Changed caption';
    fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify(timeline));
    const changed = gc('assemble');
    assert.equal((changed.match(/: rendered /g) ?? []).length, 1, changed);
    assert.match(changed, /second: cache hit/);
    assert.equal((gc('cut', 'demo').match(/: rendered /g) ?? []).length, 0);
    const styled = JSON.parse(fs.readFileSync(path.join(root, 'project.json')));
    styled.captions.background = [12, 12, 12, 225];
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(styled));
    const restyled = gc('assemble');
    assert.equal((restyled.match(/: rendered /g) ?? []).length, 1, restyled);
    assert.match(restyled, /second: cache hit/);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'clips', 'demo.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'clips', 'demo.beats.json')));
    const probe = (p) => {
      const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames:format=duration', '-of', 'json', p], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const beatFrames = manifest.reduce((n, p) => n + Number(probe(path.join(root, p)).streams[0].nb_frames), 0);
    const silent = probe(path.join(root, 'out', 'demo-silent.mp4'));
    assert.equal(Number(silent.streams[0].nb_frames), beatFrames);
    assert.ok(Math.abs(Number(silent.format.duration) - beatFrames / 30) <= 1 / 30);
    assert.ok(Math.abs(meta.duration - beatFrames / 30) <= 1 / 30);
    const capped = JSON.parse(fs.readFileSync(path.join(root, 'project.json')));
    capped.output.capSeconds = .1;
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(capped));
    const over = spawnSync(process.execPath, [cli, 'assemble', '--project', root], { encoding: 'utf8' });
    assert.notEqual(over.status, 0);
    assert.match(over.stderr, /over the cap/);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('ffmpeg fits held storyboard pieces and rejects an animated still cut', { timeout: 180000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-fit-'));
  try {
    const raw = path.join(root, 'raw', 'storyboard'), images = path.join(raw, 'frames');
    fs.mkdirSync(images, { recursive: true });
    for (const color of ['red', 'blue']) {
      const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        `color=c=${color}:s=320x180:d=0.1`, '-frames:v', '1', '-y', path.join(images, `${color}.jpg`)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name: 'fit',
      viewport: { width: 320, height: 180, dpr: 1 }, output: { width: 320, height: 180, fps: 30 } }));
    fs.writeFileSync(path.join(root, 'product.md'), '# Synthetic product\n');
    fs.writeFileSync(path.join(root, 'storyboard.yaml'), 'beats:\n  - id: held\n    say: "Now see it"\n');
    const log = [[200, '+held'], [1000, 'hold', { beat: 'held' }],
      [1500, 'show', { text: 'The result', rect: { x: 30, y: 30, w: 100, h: 40 } }],
      [9000, 'holdend'], [9650, '-held']];
    fs.writeFileSync(path.join(raw, 'log.json'), JSON.stringify(log));
    const cli = path.resolve(dir, '..', '..', 'bin', 'ghostcast.mjs');
    const cutTake = () => {
      const result = spawnSync(process.execPath, [cli, 'cut', 'storyboard', '--project', root],
        { encoding: 'utf8', timeout: 120000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(fs.readFileSync(path.join(root, 'clips', 'storyboard.json')));
    };
    const probe = (file) => {
      const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames',
        '-of', 'csv=p=0', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return Number(result.stdout.trim());
    };
    fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify([[0, 'red.jpg']]));
    const still = cutTake();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'clips', 'storyboard.beats.json')));
    assert.ok(manifest.length > 1);
    assert.equal(manifest.length, still.segments[0].pieces.length);
    assert.equal(probe(path.join(root, 'clips', 'storyboard.mp4')),
      manifest.reduce((sum, name) => sum + probe(path.join(root, name)), 0));
    assert.ok(Math.abs(still.duration - probe(path.join(root, 'clips', 'storyboard.mp4')) / 30) <= .001);
    fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify([[0, 'red.jpg'], [5000, 'blue.jpg']]));
    const animated = cutTake();
    assert.ok(animated.segments[0].fit.removed < still.segments[0].fit.removed);
    assert.ok(animated.segments[0].fit.removed <= .051, 'the animated hold must not be cut');
    assert.ok(animated.segments[0].fit.speed > 1.5);
    const plan = beat_plan(log, [[0, 'red.jpg'], [5000, 'blue.jpg']],
      { output: { fps: 30 } }, 320, 180,
      { targets: { held: 2 }, unstable: { held: [{ a: 1, b: 9 }] } });
    assert.ok(plan.beats.slice(1).every((b, i) => !(plan.beats[i].b < 9 && b.a > 1 && b.a - plan.beats[i].b > 1e-8)));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('reading time grows with the target text and is capped: a paragraph is glanced at, not read through', () => {
  assert.equal(readingSeconds('Saved'), 0.5 + 1 / 3);
  assert.equal(readingSeconds('Format conformance score: 100/100'), 0.5 + 5 / 3);
  assert.equal(readingSeconds(Array(40).fill('word').join(' ')), 4);
  assert.equal(readingSeconds(Array(40).fill('word').join(' '), { direction: { readingMax: 6 } }), 6);
});

test('fades mark only the first fitted piece and identify the previous segment, item or colour', () => {
  const beats = [
    { segment: 'one', start: 0, end: 1 },
    { segment: 'one', start: 1, end: 2 },
    { segment: 'two', start: 2, end: 3 },
    { segment: 'two', start: 3, end: 4 },
    { segment: 'three', start: 4, end: 5 },
  ];
  const item = { take: 'demo', transitions: { one: 'fade', two: 'fade', three: 'cut' } };
  const plan = transitionPlan(beats, item, { direction: { fadeSeconds: .4 }, transitions: { color: '#123456' } });
  assert.deepEqual(plan.map((b) => b.fade), [
    { seconds: .4, offset: 0, from: { color: '#123456' } }, undefined,
    { seconds: .4, offset: 0, from: { piece: 1, segment: 'one' } }, undefined, undefined,
  ]);
  assert.deepEqual(transitionPlan(beats, item, {}, { take: 'previous', segment: 'last' })[0].fade,
    { seconds: .5, offset: 0, from: { take: 'previous', segment: 'last' } });
  assert.deepEqual(transitionPlan(beats, item, {})[0].fade.from, { color: '#000000' });
  assert.deepEqual(plan.map(({ fade, ...b }) => b), beats, 'no timestamps shift');
  assert.ok(beats.every((b) => !b.fade), 'planning does not mutate inputs');
  // A segment opening with a piece shorter than the dissolve carries it into the next pieces,
  // all fading the same outgoing picture.
  const short = transitionPlan([{ segment: 'zero', start: 0, end: 1 }, { segment: 'one', start: 1, end: 1.2 },
    { segment: 'one', start: 1.2, end: 1.35 }, { segment: 'one', start: 1.35, end: 3 }, { segment: 'one', start: 3, end: 4 }], item, {});
  assert.deepEqual(short.map((b) => b.fade && [b.fade.offset.toFixed(2), b.fade.from.piece]),
    [undefined, ['0.00', 0], ['0.20', 0], ['0.35', 0], undefined]);
  const log = [[200, '+one'], [1000, 'hold', { beat: 'one' }], [9000, 'holdend'], [9650, '-one'],
    [11000, '+two'], [12000, '-two']];
  const fitted = beat_plan(log, [[0, 'frame.jpg']], { output: { fps: 30 } }, 320, 180,
    { targets: { one: 4 }, item });
  assert.ok(fitted.beats.filter((b) => b.segment === 'one').length > 1);
  assert.deepEqual(fitted.beats.filter((b) => b.fade).map((b) => b.segment), ['one', 'two']);
});

test('storyboard caption windows keep the segment offsets and cap even when transitions fade', () => {
  const meta = { duration: 33, segments: [{ segment: 'intro', start: 0, end: 3 }, { segment: 'long', start: 3, end: 33 }] };
  const item = { take: 'storyboard', transitions: { intro: 'fade', long: 'fade' }, captions: [
    { text: 'Begin here', from: 'intro', at: .3, until: 3 },
    { text: 'See the result', from: 'long', at: .3, until: 7.8 },
  ] };
  close(windows(item, meta), [['Begin here', .3, 3, 'bottom'], ['See the result', 3.3, 10.8, 'bottom']]);
  assert.deepEqual(captionPieces(windows(item, meta), { start: 3, end: 4 }),
    [{ text: 'See the result', pos: 'bottom', a: 3.3 - 3, b: 1, fadeIn: true, fadeOut: false }]);
});

test('only the faded first piece cache key depends on the previous output frame', () => {
  const item = { transitions: { two: 'fade' } };
  const beats = transitionPlan([
    { segment: 'one', a: 0, b: 1, start: 0, end: 1, ticks: [] },
    { segment: 'two', a: 1, b: 2, start: 1, end: 2, ticks: [] },
    { segment: 'two', a: 2, b: 3, start: 2, end: 3, ticks: [] },
  ], item, {});
  const key = (beat, previousFrameHash) => beatCacheKey({ take: 'demo', cfg: { output: { width: 320, height: 180, fps: 30 } },
    beat, keys: [], logEvents: [], pieces: [], source: [], captionImages: [], previousFrameHash });
  assert.deepEqual(beats.map((b) => key(b, 'old') !== key(b, 'changed')), [false, true, false]);
  assert.notEqual(key(beats[1], 'old'), key({ ...beats[1], fade: { ...beats[1].fade, seconds: .3 } }, 'old'));
  assert.notEqual(key(beats[1], 'old'), key({ ...beats[1], fade: undefined }, 'old'));
});

test('Chrome + ffmpeg: dissolve matches the outgoing output frame, resumes B and preserves duration', { timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-fade-'));
  try {
    const raw = path.join(root, 'raw', 'demo'), images = path.join(raw, 'frames');
    fs.mkdirSync(images, { recursive: true });
    for (const [name, source] of [['first', 'testsrc2=s=320x180:d=0.1'], ['second', 'smptebars=s=320x180']])
      await ffmpeg(['-f', 'lavfi', '-i', source, '-frames:v', '1', '-y', path.join(images, name + '.jpg')]);
    const project = { name: 'fade', viewport: { width: 320, height: 180, dpr: 1 },
      output: { width: 320, height: 180, fps: 30 }, captions: { size: 18 }, direction: { fadeSeconds: .5 } };
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(project));
    const log = [[200, '+first@2x'], [600, 'focus', { x: 40, y: 20, w: 80, h: 45 }], [3850, '-first@2x'],
      [5200, '+second'], [7200, '-second']];
    const frames = [[0, 'first.jpg'], [4500, 'second.jpg'], [5500, 'first.jpg']];
    fs.writeFileSync(path.join(raw, 'log.json'), JSON.stringify(log));
    fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify(frames));
    const timeline = { items: [{ take: 'demo', transitions: {} }] };
    const write = () => fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify(timeline));
    write();
    const plain = await renderCut(root, 'demo');
    timeline.items[0].transitions = { second: 'fade' }; write();
    const faded = await renderCut(root, 'demo');
    assert.deepEqual(faded.meta, plain.meta);
    assert.equal(faded.paths[0], plain.paths[0]);
    assert.notEqual(faded.paths[1], plain.paths[1]);
    const capture = async (clip, frame, name) => {
      const dest = path.join(root, name + '.png');
      await ffmpeg(['-i', clip, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-y', dest]);
      return dest;
    };
    const compare = async (a, b) => {
      const report = await ffmpegStderr(['-i', a, '-i', b, '-filter_complex', '[0:v][1:v]ssim[out]',
        '-map', '[out]', '-frames:v', '1', '-f', 'null', '-']);
      const score = Number(/All:\s*([\d.]+)/.exec(report)?.[1]);
      assert.ok(Number.isFinite(score), report); return score;
    };
    const firstFrames = Math.round((faded.meta.segments[0].end - faded.meta.segments[0].start) * 30);
    const lastA = await capture(faded.paths[0], firstFrames - 1, 'last-a');
    const firstB = await capture(faded.paths[1], 0, 'first-b');
    const initialSsim = await compare(lastA, firstB);
    assert.ok(initialSsim > .95, `B starts with A including its perspective and speed tag (SSIM ${initialSsim})`);
    const after = Math.round((project.direction.fadeSeconds + .1) * 30);
    assert.ok(await compare(await capture(faded.paths[1], after, 'faded-after'),
      await capture(plain.paths[1], after, 'plain-after')) > .95);
    const duration = () => {
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames:format=duration', '-of', 'json',
        path.join(root, 'clips', 'demo.mp4')], { encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr); return JSON.parse(probe.stdout);
    };
    const joined = duration();
    assert.equal(Number(joined.streams[0].nb_frames), Math.round(faded.meta.duration * 30));
    assert.ok(Math.abs(Number(joined.format.duration) - plain.meta.duration) <= 1 / 30);
    await renderAssemble(root);
    const assembled = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0',
      path.join(root, 'out', 'fade-silent.mp4')], { encoding: 'utf8' });
    assert.equal(assembled.status, 0, assembled.stderr);
    assert.equal(Number(assembled.stdout.trim()), Number(joined.streams[0].nb_frames));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('Chrome + ffmpeg: lower thirds wrap at fixed size, mirror at the top and keep the corner tag', { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-caption-look-'));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const project = { output: { width: 1920, height: 1080 }, captions: { size: 34, accent: '#7c6cf6' } };
    const text = 'A clear caption explains the result and helps every viewer follow the software demonstration on screen';
    const assets = {};
    for (const pos of ['bottom', 'top', 'corner']) {
      const file = await pill(root, project, pos === 'corner' ? '2×' : text, pos, async () => browser);
      const read = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
        { maxBuffer: 1920 * 1080 * 4 + 1024 });
      assert.equal(read.status, 0, read.stderr?.toString());
      const data = read.stdout, rows = new Set();
      let left = 1920, right = 0, top = 1080, bottom = 0, white = 0, accent = 0;
      for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
        const i = (y * 1920 + x) * 4;
        if (!data[i + 3]) continue;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) { white++; rows.add(y); }
        if (data[i] === 124 && data[i + 1] === 108 && data[i + 2] === 246) accent++;
      }
      assert.ok(white > 0);
      assets[pos] = { left, right, top, bottom, rows, accent };
      if (pos !== 'corner') {
        assert.ok(right - left + 1 <= Math.floor(1920 * .7));
        assert.ok(accent > 0);
        // Two lines at the configured size make a box exactly two line heights plus its padding
        // tall. (Counting bright text rows instead depends on each OS's font smoothing.)
        assert.ok(Math.abs(bottom - top + 1 - (2 * Math.ceil(34 * 1.25) + 2 * Math.round(34 * .6))) <= 2,
          `text wraps to two lines at the configured font size (box ${bottom - top + 1} px tall)`);
        assert.ok(bottom - top + 1 >= 2 * Math.ceil(34 * 1.25));
        const center = ((top + bottom) >> 1) * 1920 + ((left + right) >> 1);
        assert.ok(data[center * 4 + 3] >= 225, 'background is slightly translucent');
      } else assert.equal(accent, 0);
    }
    assert.equal(assets.top.top, Math.round(1080 * .06));
    assert.equal(1080 - assets.bottom.bottom - 1, Math.round(1080 * .06));
    assert.equal(assets.top.bottom - assets.top.top, assets.bottom.bottom - assets.bottom.top);
    assert.equal(assets.top.left, assets.bottom.left);
    assert.equal(assets.corner.top, Math.round(Math.round(1080 * .05) * .75));
  } finally { await browser?.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('ffmpeg: first colour fades and cross-item fades reuse only the changed dependent piece', { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostcast-cross-fade-'));
  const previousJobs = process.env.GHOSTCAST_JOBS; process.env.GHOSTCAST_JOBS = '4';
  try {
    const project = { name: 'cross', viewport: { width: 320, height: 180, dpr: 1 },
      output: { width: 320, height: 180, fps: 30 }, transitions: { color: '#123456' } };
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(project));
    fs.writeFileSync(path.join(root, 'product.md'), '# Synthetic product\n');
    fs.writeFileSync(path.join(root, 'storyboard.yaml'), 'beats:\n  - id: held\n    say: One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen\n');
    for (const take of ['prior', 'storyboard']) {
      const raw = path.join(root, 'raw', take); fs.mkdirSync(path.join(raw, 'frames'), { recursive: true });
      await ffmpeg(['-f', 'lavfi', '-i', take === 'prior' ? 'testsrc2=s=320x180:d=0.1' : 'smptebars=s=320x180',
        '-frames:v', '1', '-y', path.join(raw, 'frames', 'frame.jpg')]);
      fs.writeFileSync(path.join(raw, 'frames.json'), JSON.stringify([[0, 'frame.jpg']]));
      const log = take === 'prior' ? [[200, '+previous'], [1850, '-previous']]
        : [[200, '+held'], [1000, 'hold', { beat: 'held' }], [9000, 'holdend'], [9650, '-held']];
      fs.writeFileSync(path.join(raw, 'log.json'), JSON.stringify(log));
    }
    fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify({ items: [
      { take: 'prior', transitions: { previous: 'fade' } },
      { take: 'storyboard', transitions: { held: 'fade' } },
    ] }));
    const faded = await renderCut(root, 'storyboard');
    assert.ok(fs.existsSync(path.join(root, 'clips', 'prior.mp4')), 'missing predecessor is rendered first');
    assert.ok(faded.paths.length > 1, 'the incoming segment has fitted pieces');
    const before = [...faded.paths];
    const first = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(root, 'clips', 'prior.mp4'),
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 320 * 180 * 3 + 1024 });
    assert.equal(first.status, 0, first.stderr?.toString());
    assert.ok(Math.abs(first.stdout[0] - 18) < 8 && Math.abs(first.stdout[1] - 52) < 8 && Math.abs(first.stdout[2] - 86) < 8,
      'the first beat fades from the configured solid colour');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=0.1', '-frames:v', '1', '-y',
      path.join(root, 'raw', 'prior', 'frames', 'frame.jpg')]);
    await renderCut(root, 'prior');
    await renderAssemble(root);
    const after = JSON.parse(fs.readFileSync(path.join(root, 'clips', 'storyboard.beats.json'))).map((p) => path.resolve(root, p));
    assert.notEqual(after[0], before[0]);
    assert.deepEqual(after.slice(1), before.slice(1), 'only the faded first piece depends on its predecessor');
    assert.deepEqual((await renderCut(root, 'storyboard')).paths, after, 'warm cache reuses every piece');
  } finally {
    if (previousJobs === undefined) delete process.env.GHOSTCAST_JOBS; else process.env.GHOSTCAST_JOBS = previousJobs;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
