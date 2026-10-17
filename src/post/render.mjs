import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { beat_plan, transitionPlan, windows, captionPieces, box_at, segments } from './logic.mjs';
import { directCamera, fitTargets, motionIntervals, direction } from './fit.mjs';
import { loadProject } from '../project.mjs';

export const VERSION = 'perspective-beats-10';
const ENCODER = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
const FFMPEG_BUILD = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).stdout?.split(/\r?\n/)[0] ?? 'unknown';
// A beat's filter graph can pass Windows' 32 767-character command line, so it goes in a file.
// ffmpeg 7 reads any option from a file with "-/option"; newer builds dropped -filter_complex_script,
// which 6.x (Ubuntu 24.04's) still needs. A git build without a version number counts as new.
const FILTER_FILE = Number(/version n?(\d+)\./.exec(FFMPEG_BUILD)?.[1] ?? 99) < 7 ? '-filter_complex_script' : '-/filter_complex';
const FONTS = ['C:/Windows/Fonts/seguisb.ttf', '/System/Library/Fonts/SFNS.ttf',
  '/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hashFile = (p) => sha(fs.readFileSync(p));
const tmpName = (p) => `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.mp4`;
function captionSignature(root, cfg, caps, item = {}, previousClip = null) {
  const font = !caps.length ? null : cfg.captions?.font ? path.resolve(root, cfg.captions.font) : FONTS.find((p) => fs.existsSync(p));
  return sha(JSON.stringify({ caps, style: caps.length ? cfg.captions : null, font: font ? hashFile(font) : null,
    width: cfg.output.width, height: cfg.output.height, fps: cfg.output.fps, version: VERSION,
    transitions: item.transitions ?? {}, fadeSeconds: cfg.direction?.fadeSeconds ?? .5,
    color: cfg.transitions?.color ?? '#000000', previousClip: previousClip ? hashFile(previousClip) : null }));
}

async function runFfmpeg(args, capture) {
  return await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', ...(capture ? [] : ['-loglevel', 'error']), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    // A quick run (an SSIM of two frames) can finish before this: a process that is gone (ESRCH)
    // needs no lowering. Without a pid, spawn failed and 'error' reports it.
    if (child.pid) {
      try { os.setPriority(child.pid, process.platform === 'win32' ? os.constants.priority.PRIORITY_BELOW_NORMAL : 10); }
      catch (e) {
        if (!(e.info?.code === 'ESRCH' || /ESRCH/.test(e.message))) { child.kill(); reject(new Error(`cannot lower ffmpeg priority: ${e.message}`)); return; }
      }
    }
    let err = '';
    child.stderr.on('data', (x) => { err += x; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(capture ? err : undefined) : reject(new Error(`ffmpeg exited ${code}: ${err}`)));
  });
}

export async function ffmpeg(args) { return runFfmpeg(args, false); }
export async function ffmpegStderr(args) { return runFfmpeg(args, true); }

export function probeSize(p) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', p], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed for ${p}: ${r.stderr}`);
  const { width, height } = JSON.parse(r.stdout).streams[0];
  return [width, height];
}

// ffconcat uses one JPEG per distinct (file, box) run. Perspective sees each once; fps later
// repeats the warped result for all of the run's output ticks.
export function runs(ticks) {
  const out = [];
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i], prev = out.at(-1);
    if (prev && prev.file === t.file && prev.box.every((v, j) => v === t.box[j])) prev.count++;
    else out.push({ file: t.file, box: t.box, count: 1 });
  }
  return out;
}

// ffmpeg parses a flat a+b+c… (or a;b;c…) into a tree as deep as it has terms, and refuses one
// about 100 deep: perspective failed with "Cannot allocate memory" on a long beat whose warp
// timing summed 93 repeated-frame terms. Balanced, the same sum (or sequence: statements still
// run in order and the last one's value is kept) is only log2(n) deep.
export function balancedSum(terms, op = '+') {
  if (terms.length <= 1) return terms[0] ?? '0';
  const mid = terms.length >> 1;
  return `(${balancedSum(terms.slice(0, mid), op)}${op}${balancedSum(terms.slice(mid), op)})`;
}

export function perspectiveExpressions(runs, beat, keys) {
  const same = runs.every((r) => r.box.every((v, i) => v === runs[0].box[i]));
  const corner = (box, i) => i === 0 ? box[0] : i === 1 ? box[1] : i === 2 ? box[0] + box[2] : box[1] + box[3];
  if (same) return [0, 1, 2, 3].map((i) => corner(runs[0].box, i).toFixed(9));

  const first = beat.ticks[0].sourceTime, last = beat.ticks.at(-1).sourceTime;
  let initial = keys[0][1];
  let moves = [];
  for (const [tk, target] of keys.slice(1)) {
    if (tk + .75 <= first) { initial = target; moves = []; }
    else if (tk <= last) moves.push([tk, target]);
  }
  const offsets = runs.slice(0, -1).flatMap((r, i) => r.count > 1 ? [`${r.count - 1}*gte(in\\,${i + 2})`] : []);
  const tick = `(in-1${offsets.length ? '+' + balancedSum(offsets) : ''})`;
  const time = `st(1\\,${beat.a.toFixed(9)}+${tick}*${(beat.speed / beat.fps).toFixed(12)})`;
  return [0, 1, 2, 3].map((i) => {
    if (!moves.length) return corner(initial, i).toFixed(9);
    const steps = [`st(0\\,${corner(initial, i).toFixed(9)})`, time];
    for (const [tk, target] of moves) {
      steps.push(`st(2\\,clip((ld(1)-${tk.toFixed(9)})/0.75\\,0\\,1))`);
      steps.push('st(3\\,ld(2)*ld(2)*ld(2)*(ld(2)*(ld(2)*6-15)+10))');
      steps.push(`st(0\\,ld(0)+(${corner(target, i).toFixed(9)}-ld(0))*ld(3))`);
    }
    steps.push('ld(0)');
    return balancedSum(steps, ';');
  });
}

function perspective(runs, beat, keys) {
  let enable = '';
  const active = runs.map((r, i) => r.box[2] < beat.srcW - .5 || r.box[3] < beat.srcH - .5 ? i : -1).filter((i) => i >= 0);
  if (!active.length) return '';
  if (active.length !== runs.length) {
    const spans = [];
    for (const i of active) {
      if (spans.length && i === spans.at(-1)[1] + 1) spans.at(-1)[1] = i;
      else spans.push([i, i]);
    }
    enable = `:enable='${balancedSum(spans.map(([a, b]) => `between(n\\,${a}\\,${b})`))}'`;
  }
  const [x, y, right, bottom] = perspectiveExpressions(runs, beat, keys);
  return `perspective=x0='${x}':y0='${y}':x1='${right}':y1='${y}':x2='${x}':y2='${bottom}':x3='${right}':y3='${bottom}':sense=source:eval=frame:interpolation=cubic${enable}`;
}

function concatText(paths, durations) {
  const quote = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  let out = 'ffconcat version 1.0\n';
  for (let i = 0; i < paths.length; i++) out += `file '${quote(paths[i])}'\nduration ${durations[i].toFixed(12)}\n`;
  out += `file '${quote(paths.at(-1))}'\n`;
  return out;
}

function sourcePts(rs, fps) {
  // Concat's image demuxer timestamps have a 1/25 time base on some builds. Set exact tick
  // timestamps before fps repeats holds; the sentinel frame marks the last run's end.
  const offsets = rs.map((r, i) => r.count > 1 ? `${r.count - 1}*gte(N\\,${i + 1})` : null).filter(Boolean);
  return `(N${offsets.length ? '+' + balancedSum(offsets) : ''})/(${fps}*TB)`;
}

export async function pill(root, cfg, text, pos, getBrowser) {
  const style = cfg.captions ?? {}, width = cfg.output.width, height = cfg.output.height;
  const size = Math.round((style.size ?? Math.round(34 * height / 1080)) * (pos === 'corner' ? .88 : 1));
  const fontPath = style.font ? path.resolve(root, style.font) : FONTS.find((p) => fs.existsSync(p));
  const fontBytes = fontPath ? fs.readFileSync(fontPath) : null;
  const fontData = fontBytes ? `data:font/${path.extname(fontPath).slice(1)};base64,${fontBytes.toString('base64')}` : null;
  const key = sha(JSON.stringify({ text, pos, style, size, width, height, fontHash: fontBytes ? sha(fontBytes) : null, version: VERSION }));
  const dir = path.join(root, 'cache', 'pills'); fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${key}.png`);
  if (fs.existsSync(dest)) return dest;
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    const data = await page.evaluate(async ({ text, pos, style, size, width, height, fontData }) => {
      if (fontData) { const f = new FontFace('GhostcastCaption', `url(${fontData})`); await f.load(); document.fonts.add(f); }
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      const g = c.getContext('2d');
      g.font = fontData ? `${size}px GhostcastCaption` : `600 ${size}px "Segoe UI", "Arial", sans-serif`;
      const color = (v) => typeof v === 'string' ? v : `rgba(${v[0]},${v[1]},${v[2]},${(v[3] ?? 255) / 255})`;
      const px = Math.round(size), py = Math.round(size * .6);
      let lines = [text];
      const limit = Math.floor(width * .7), available = Math.max(1, limit - 2 * px);
      if (pos !== 'corner' && g.measureText(text).width > available) {
        const words = text.split(/\s+/);
        let first = '';
        while (words.length && g.measureText([first, words[0]].filter(Boolean).join(' ')).width <= available)
          first = [first, words.shift()].filter(Boolean).join(' ');
        if (!first) {
          const chars = Array.from(words[0]);
          while (chars.length && g.measureText(first + chars[0]).width <= available) first += chars.shift();
          words[0] = chars.join('');
        }
        lines = [first, words.join(' ')];
        if (g.measureText(lines[1]).width > available) {
          const chars = Array.from(lines[1]);
          while (chars.length && g.measureText(chars.join('') + '…').width > available) chars.pop();
          lines[1] = chars.join('') + '…';
        }
      }
      const metrics = lines.map((line) => g.measureText(line));
      const lineHeight = Math.ceil(size * 1.25);
      const pw = Math.min(pos === 'corner' ? width : limit, Math.ceil(Math.max(...metrics.map((m) => m.width))) + 2 * px);
      const ph = pos === 'corner' ? Math.ceil(metrics[0].actualBoundingBoxAscent + metrics[0].actualBoundingBoxDescent) + 2 * py
        : lineHeight * lines.length + 2 * py;
      const margin = Math.round(height * (pos === 'corner' ? .05 : .06));
      const x = pos === 'corner' ? width - pw - Math.round(margin * .75) : Math.floor((width - pw) / 2);
      const y = pos === 'corner' ? Math.round(margin * .75) : pos === 'top' ? margin : height - ph - margin;
      g.fillStyle = color(style.background ?? [24, 24, 27, 225]);
      g.beginPath(); g.roundRect(x, y, pw, ph, pos === 'corner' ? ph / 2 : Math.round(size * .22)); g.fill();
      if (pos !== 'corner') {
        g.fillStyle = color(style.accent ?? '#7c6cf6');
        g.fillRect(x, y + size * .22, Math.max(2, Math.round(size * .12)), ph - size * .44);
      }
      g.fillStyle = color(style.color ?? (pos === 'corner' ? [250, 250, 250, 255] : [255, 255, 255, 255]));
      lines.forEach((line, i) => g.fillText(line, x + px, y + py + (pos === 'corner' ? metrics[0].actualBoundingBoxAscent : size) + i * lineHeight));
      return c.toDataURL('image/png').split(',')[1];
    }, { text, pos, style, size, width, height, fontData });
    fs.writeFileSync(dest, Buffer.from(data, 'base64'));
  } finally { await page.close(); }
  return dest;
}

export function beatCacheKey({ take, cfg, beat, keys, logEvents, pieces, source, captionImages, previousFrameHash = null }) {
  const fps = cfg.output.fps;
  return sha(JSON.stringify({ version: VERSION, take, segment: beat.segment, a: beat.a, b: beat.b,
    speed: beat.speed, source, stamps: beat.ticks.map((t) => [t.stamp, t.sourceTime]),
    keys: keys.filter(([t]) => t <= beat.b), logEvents, pieces, captions: pieces.length ? cfg.captions : null,
    captionImages, fade: beat.fade ? { ...beat.fade, previousFrameHash } : null,
    output: { width: cfg.output.width, height: cfg.output.height, fps }, encoder: ENCODER, ffmpeg: FFMPEG_BUILD }));
}

async function renderBeat(root, take, cfg, beat, keys, logEvents, pieces, fileHashes, getPill, previousFrame = null) {
  const raw = path.join(root, 'raw', take, 'frames');
  const rs = runs(beat.ticks), fps = cfg.output.fps;
  const assets = [];
  for (const c of pieces) assets.push(await getPill(c.text, c.pos));
  const source = rs.map((r) => ({ name: r.file, hash: fileHashes.get(r.file), count: r.count, box: r.box }));
  const hash = beatCacheKey({ take, cfg, beat, keys, logEvents, pieces, source,
    captionImages: assets.map(hashFile), previousFrameHash: previousFrame ? hashFile(previousFrame) : null });
  const dir = path.join(root, 'cache', 'beats'); fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${hash}.mp4`);
  if (fs.existsSync(dest)) { console.log(`${take} · ${beat.segment}: cache hit`); return dest; }
  const work = path.join(root, 'cache', 'work'); fs.mkdirSync(work, { recursive: true });
  const stem = `${hash}.${process.pid}`;
  const list = path.join(work, `${stem}.ffconcat`), filter = path.join(work, `${stem}.filter`);
  fs.writeFileSync(list, concatText(rs.map((r) => path.join(raw, r.file)), rs.map((r) => r.count / fps)));
  const inputs = ['-f', 'concat', '-safe', '0', '-i', list];
  const warp = perspective(rs, { ...beat, fps, srcW: keys[0][1][2], srcH: keys[0][1][3] }, keys);
  let graph = `[0:v]settb=1/${fps * 1000},setpts='${sourcePts(rs, fps)}',${warp ? `${warp},` : ''}scale=${cfg.output.width}:${cfg.output.height}:flags=lanczos,fps=${fps},format=yuv420p[base]`;
  let last = '[base]';
  if (beat.fade) {
    if (previousFrame) inputs.push('-stream_loop', '-1', '-i', previousFrame);
    else inputs.push('-f', 'lavfi', '-i', `color=c=${beat.fade.from.color.replace(/^#/, '0x')}:s=${cfg.output.width}x${cfg.output.height}:r=${fps}`);
    // A piece that continues a dissolve picks the fade up `offset` seconds in.
    const offset = beat.fade.offset ? `,trim=start=${beat.fade.offset.toFixed(6)},setpts=PTS-STARTPTS` : '';
    graph += `;[1:v]settb=1/${fps * 1000},setpts=PTS-STARTPTS,format=yuva420p,fade=out:st=0:d=${beat.fade.seconds.toFixed(6)}:alpha=1${offset}[outgoing];[base][outgoing]overlay=0:0:shortest=1[dissolved]`;
    last = '[dissolved]';
  }
  for (let i = 0; i < pieces.length; i++) {
    const c = pieces[i], png = assets[i];
    inputs.push('-loop', '1', '-framerate', String(fps), '-i', png);
    let chain = `[${i + (beat.fade ? 2 : 1)}:v]format=rgba`;
    if (c.fadeIn) chain += `,fade=in:st=${Math.max(0, c.a).toFixed(6)}:d=0.25:alpha=1`;
    if (c.fadeOut) chain += `,fade=out:st=${Math.max(c.a, c.b - .25).toFixed(6)}:d=0.25:alpha=1`;
    graph += `;${chain}[cap${i}];${last}[cap${i}]overlay=0:0:enable='between(t,${c.a.toFixed(6)},${c.b.toFixed(6)})'[v${i}]`;
    last = `[v${i}]`;
  }
  fs.writeFileSync(filter, graph);
  const tmp = tmpName(dest);
  try {
    await ffmpeg([...inputs, FILTER_FILE, filter, '-map', last, '-frames:v', String(beat.ticks.length), '-r', String(fps), ...ENCODER, '-y', tmp]);
    fs.renameSync(tmp, dest);
  } finally {
    for (const p of [list, filter, tmp]) { try { fs.unlinkSync(p); } catch {} }
  }
  console.log(`${take} · ${beat.segment}: rendered ${beat.ticks.length} ticks from ${rs.length} distinct views`);
  return dest;
}

async function join(paths, dest, root) {
  const dir = path.join(root, 'cache', 'work'); fs.mkdirSync(dir, { recursive: true });
  const list = path.join(dir, `join.${process.pid}.${crypto.randomBytes(4).toString('hex')}.ffconcat`);
  fs.writeFileSync(list, 'ffconcat version 1.0\n' + paths.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\n`).join(''));
  const tmp = tmpName(dest);
  try { await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', tmp]); fs.renameSync(tmp, dest); }
  finally { for (const p of [list, tmp]) { try { fs.unlinkSync(p); } catch {} } }
}

async function previousTimelineClip(root, take) {
  const file = path.join(root, 'timeline.json');
  if (!fs.existsSync(file)) return null;
  const items = readJson(file).items, index = items.findIndex((item) => item.take === take);
  if (index < 1) return null;
  const previous = items[index - 1].take;
  const clip = path.join(root, 'clips', `${previous}.mp4`);
  if (!fs.existsSync(clip)) await cut(root, previous);
  const manifest = path.join(root, 'clips', `${previous}.beats.json`);
  const last = fs.existsSync(manifest) ? readJson(manifest).at(-1) : null;
  return last && fs.existsSync(path.resolve(root, last)) ? path.resolve(root, last) : clip;
}

async function lastFrame(root, clip) {
  const dir = path.join(root, 'cache', 'frames'); fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${hashFile(clip)}.y4m`);
  if (fs.existsSync(dest)) return dest;
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.y4m`;
  try {
    // Reverse the decoded tail to select the last frame; YUV avoids an RGB chroma round trip.
    await ffmpeg(['-sseof', '-1', '-i', clip, '-an', '-vf', 'reverse', '-frames:v', '1',
      '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', '-y', tmp]);
    fs.renameSync(tmp, dest);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  return dest;
}

export async function cut(root, take) {
  const cfg = loadProject(root).config;
  const raw = path.join(root, 'raw', take), frames = readJson(path.join(raw, 'frames.json')), log = readJson(path.join(raw, 'log.json'));
  if (!frames.length) throw new Error(`${take}: no frames`);
  const [w, h] = probeSize(path.join(raw, 'frames', frames[0][1]));
  const { targets, readings } = fitTargets(root, take, log, cfg);
  const unstable = {};
  let plan;
  for (let round = 0; round < 3; round++) {
    plan = beat_plan(log, frames, cfg, w, h, { targets, readings, unstable });
    const vp = log.find((e) => e[1] === 'viewport')?.[2];
    const directed = directCamera(log, cfg, w, h, vp ? w / vp.w : 1);
    const rejected = [];
    for (const segment of segments(log)) {
      if (!plan.meta.segments.some((s) => s.segment === segment.name && s.fit)) continue;
      const parts = plan.beats.filter((beat) => beat.segment === segment.name);
      const intervals = motionIntervals(segment, directed, cfg).still;
      for (let i = 1; i < parts.length; i++) {
        const left = parts[i - 1], right = parts[i];
        if (right.a - left.b < 1e-6) continue;
        const before = frames.filter(([ms]) => ms / 1000 <= left.b).at(-1) ?? frames[0];
        const after = frames.find(([ms]) => ms / 1000 >= right.a) ?? frames.at(-1);
        if (before[1] === after[1]) continue;
        const box = box_at(plan.keys, left.b);
        const x = Math.max(0, Math.min(w - 1, Math.round(box[0]))), y = Math.max(0, Math.min(h - 1, Math.round(box[1])));
        const cw = Math.max(1, Math.min(w - x, Math.round(box[2]))), ch = Math.max(1, Math.min(h - y, Math.round(box[3])));
        const view = `crop=${cw}:${ch}:${x}:${y},scale=480:-2,format=gray`;
        const filter = `[0:v]${view}[a];[1:v]${view}[b];[a][b]ssim[out]`;
        const report = await ffmpegStderr(['-i', path.join(raw, 'frames', before[1]), '-i', path.join(raw, 'frames', after[1]),
          '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-f', 'null', '-']);
        const score = Number(/All:\s*([\d.]+)/.exec(report)?.[1]);
        if (!Number.isFinite(score)) throw new Error(`${take} · ${segment.name}: ffmpeg did not report still SSIM`);
        if (score < direction(cfg).stillSsim) {
          const still = intervals.find((s) => s.a <= left.b + 1e-6 && s.b >= right.a - 1e-6);
          if (still) rejected.push({ name: segment.name, span: { a: still.a, b: still.b } });
        }
      }
    }
    if (!rejected.length) break;
    if (round === 2) throw new Error(`${take}: frame stability did not converge after three planning rounds`);
    for (const { name, span } of rejected) (unstable[name] ??= []).push(span);
  }
  if (!plan.beats.length) throw new Error(`${take}: no segments in log`);
  for (const s of plan.meta.segments) if (s.fit) {
    const note = [s.fit.output > s.fit.natural + .05 ? `held +${(s.fit.output - s.fit.natural).toFixed(1)} s` : `stills −${s.fit.removed.toFixed(1)} s`];
    if (s.fit.speed > 1.001) note.push(`moves ${s.fit.speed.toFixed(1)}×`);
    if (s.fit.overrun > .001) note.push(`overrun ${s.fit.overrun.toFixed(1)} s`);
    if (s.fit.shortfall > .001) note.push(`shortfall ${s.fit.shortfall.toFixed(1)} s`);
    console.log(`${take} · ${s.segment}: ${s.fit.natural.toFixed(1)} s → ${s.fit.output.toFixed(1)} s (${note.join(', ')})`);
  }
  const item = (fs.existsSync(path.join(root, 'timeline.json')) ? readJson(path.join(root, 'timeline.json')).items : []).find((x) => x.take === take) ?? { take };
  const firstFade = item.transitions?.[plan.beats[0].segment] === 'fade';
  const previousClip = firstFade ? await previousTimelineClip(root, take) : null;
  const previous = previousClip ? { take: readJson(path.join(root, 'timeline.json')).items
    .find((_, index, items) => items[index + 1]?.take === take)?.take } : null;
  plan.beats = transitionPlan(plan.beats, item, cfg, previous);
  const meta = { take, ...plan.meta }, caps = windows(item, meta);
  const hashes = new Map();
  for (const b of plan.beats) for (const tick of b.ticks) if (!hashes.has(tick.file)) hashes.set(tick.file, hashFile(path.join(raw, 'frames', tick.file)));
  let browserPromise;
  const getBrowser = () => browserPromise ??= chromium.launch({ channel: cfg.browser?.channel ?? 'chrome', headless: true });
  const pillJobs = new Map();
  const getPill = (text, pos) => {
    const key = JSON.stringify([text, pos]);
    if (!pillJobs.has(key)) pillJobs.set(key, pill(root, cfg, text, pos, getBrowser));
    return pillJobs.get(key);
  };
  const maxJobs = process.env.GHOSTCAST_JOBS === undefined ? 1 : Number(process.env.GHOSTCAST_JOBS);
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1) throw new Error('GHOSTCAST_JOBS must be a positive integer');
  let active = 0; const waiting = [], renders = [], frameJobs = new Map();
  const frame = (clip) => {
    if (!frameJobs.has(clip)) frameJobs.set(clip, lastFrame(root, clip));
    return frameJobs.get(clip);
  };
  const render = async (b) => {
    const clip = b.fade && (b.fade.from.piece !== undefined ? await renders[b.fade.from.piece] : previousClip);
    const previousFrame = clip ? await frame(clip) : null;
    if (active >= maxJobs) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await renderBeat(root, take, cfg, b, plan.keys,
        log.filter(([ms]) => ms / 1000 >= b.a && ms / 1000 <= b.b), captionPieces(caps, b), hashes, getPill, previousFrame);
    } finally {
      if (waiting.length) waiting.shift()();
      else active--;
    }
  };
  let paths;
  try {
    for (const b of plan.beats) renders.push(render(b));
    const results = await Promise.allSettled(renders);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    paths = results.map((result) => result.value);
  } finally {
    if (browserPromise) { const browser = await browserPromise.catch(() => null); await browser?.close(); }
  }
  const dir = path.join(root, 'clips'); fs.mkdirSync(dir, { recursive: true });
  await join(paths, path.join(dir, `${take}.mp4`), root);
  writeJson(path.join(dir, `${take}.json`), meta);
  writeJson(path.join(dir, `${take}.beats.json`), paths.map((p) => path.relative(root, p)));
  writeJson(path.join(dir, `${take}.captions.json`), { signature: captionSignature(root, cfg, caps, item, previousClip) });
  console.log(`${take}: ${plan.beats.length} beat(s), ${plan.beats.reduce((n, b) => n + b.ticks.length, 0)} frames, ${meta.duration.toFixed(2)}s`);
  return { paths, meta, caps };
}

export async function assemble(root) {
  const cfg = loadProject(root).config, timeline = readJson(path.join(root, 'timeline.json'));
  let t = 0; const paths = [], cues = [], missing = [];
  for (const item of timeline.items) {
    const clip = path.join(root, 'clips', `${item.take}.mp4`);
    if (!fs.existsSync(clip)) { cues.push(`| — | **${item.take}** | MISSING: not cut yet |`); missing.push(item.take); continue; }
    let meta = readJson(path.join(root, 'clips', `${item.take}.json`));
    let caps = windows(item, meta);
    const previousClip = item.transitions?.[meta.segments[0]?.segment] === 'fade' ? await previousTimelineClip(root, item.take) : null;
    const signature = path.join(root, 'clips', `${item.take}.captions.json`);
    const manifestFile = path.join(root, 'clips', `${item.take}.beats.json`);
    const missingBeats = !fs.existsSync(manifestFile) || readJson(manifestFile).some((p) => !fs.existsSync(path.resolve(root, p)));
    if (missingBeats || !fs.existsSync(signature) || readJson(signature).signature !== captionSignature(root, cfg, caps, item, previousClip)) {
      if (!fs.existsSync(path.join(root, 'raw', item.take, 'frames.json')))
        throw new Error(`${item.take}: beats need rendering, but raw frames are missing; run cut with the raw take available`);
      await cut(root, item.take);
      meta = readJson(path.join(root, 'clips', `${item.take}.json`));
      caps = windows(item, meta);
    }
    const manifest = readJson(manifestFile);
    if (manifest.length !== meta.segments.reduce((n, s) => n + (s.pieces?.length ?? 1), 0))
      throw new Error(`${item.take}: beat manifest does not match clip metadata; run cut again`);
    const beatPaths = manifest.map((p) => path.resolve(root, p));
    paths.push(...beatPaths);
    const rows = [];
    for (const s of meta.segments) {
      const speed = s.speed >= 1.5 ? ` at ${s.speed.toFixed(1)}×` : '';
      rows.push([s.start, 0, `| ${(t + s.start).toFixed(2).padStart(6)} | ${item.take} · ${s.segment} | ${(s.end - s.start).toFixed(1)}s${speed} |`]);
    }
    for (const [text, a, b, pos] of caps) if (pos !== 'corner') rows.push([a, 1, `| ${(t + a).toFixed(2).padStart(6)} | ↳ caption | ${text} (${(b - a).toFixed(1)}s) |`]);
    cues.push(...rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((r) => r[2]));
    t += meta.duration;
  }
  if (!paths.length) throw new Error('nothing to assemble: no take in timeline.json has a clip (run: ghostcast cut <take>)');
  const outDir = path.join(root, 'out'); fs.mkdirSync(outDir, { recursive: true });
  const name = cfg.name ?? 'screencast', out = path.join(outDir, `${name}-silent.mp4`);
  await join(paths, out, root);
  fs.writeFileSync(path.join(outDir, `${name}.cues.md`), `# Cue sheet — ${path.basename(out)} (${t.toFixed(2)}s)\n\n| Time | Segment / caption | Length / text |\n|---|---|---|\n${cues.join('\n')}\n`);
  console.log(`${out}: ${t.toFixed(2)}s from ${timeline.items.length - missing.length} take(s)${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
  if (cfg.output.capSeconds && t > cfg.output.capSeconds) throw new Error(`over the cap: ${t.toFixed(2)}s > ${cfg.output.capSeconds}s`);
}
