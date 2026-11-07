#!/usr/bin/env node
// zq — a file queue between a producer (Claude Code, a script, you) and a ZCode Automation (the worker).
//
//   Setup:     zq init --allow DIR [--allow DIR ...]     create the queue and its config
//              zq automation                             print the instructions for the ZCode Automation
//   Producer:  zq submit --cwd DIR [--mode read-only|edit] [--title T] (-m TEXT | --file F | stdin)  -> id
//              zq wait ID [--timeout SEC] [--interval SEC]
//              zq result ID | zq status [--limit N] | zq cancel ID | zq prune [--days N]
//   Worker:    zq claim                                  JSON with up to max_parallel claimed tasks
//              zq finish ID --status done|failed --summary TEXT
//
// Layout (under ZQ_ROOT, default ~/zcode-queue):
//   config.json       allowed_roots, max_parallel, stale_minutes
//   inbox/<id>.md     waiting tasks (front matter + task text)
//   working/<id>.md   claimed tasks; at most max_parallel at a time
//   outbox/<id>.md    the agent's full answer
//   outbox/<id>/      extra output files (optional)
//   outbox/<id>.json  status record, written last; its presence means "finished"
//
// Exit codes: 0 ok/done, 1 task failed or bad input, 2 wait timed out / not finished, 3 unknown id.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// `zq status | head` closes the pipe early: that is not an error.
process.stdout.on('error', (e) => process.exit(e.code === 'EPIPE' ? 0 : 1));

const HOME = os.homedir();
const SCRIPT = realOrResolve(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.dirname(SCRIPT);
const ROOT = path.resolve(expandHome(process.env.ZQ_ROOT || path.join(HOME, 'zcode-queue')));
const CONFIG = path.join(ROOT, 'config.json');
const INBOX = path.join(ROOT, 'inbox');
const WORKING = path.join(ROOT, 'working');
const OUTBOX = path.join(ROOT, 'outbox');
const MODES = ['read-only', 'edit'];
const DEFAULTS = { allowed_roots: [], max_parallel: 2, stale_minutes: 90 };

function expandHome(p) {
  return p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p;
}

function realOrResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function die(msg, code = 1) {
  process.stderr.write(`zq: ${msg}\n`);
  process.exit(code);
}

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; }
}

function loadConfig() {
  const cfg = { ...DEFAULTS, ...(readConfigFile() ?? {}) };
  cfg.allowed_roots = (Array.isArray(cfg.allowed_roots) ? cfg.allowed_roots : [])
    .map((r) => realOrResolve(expandHome(String(r))));
  cfg.max_parallel = Math.max(1, Number(cfg.max_parallel) || DEFAULTS.max_parallel);
  cfg.stale_minutes = Math.max(1, Number(cfg.stale_minutes) || DEFAULTS.stale_minutes);
  return cfg;
}

function requireRoots(cfg) {
  if (!cfg.allowed_roots.length)
    die(`no allowed_roots in ${CONFIG}. Run: zq init --allow <folder where tasks may run>`);
}

function ensureDirs() {
  for (const d of [ROOT, INBOX, WORKING, OUTBOX]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700); // keep the queue private even if a folder was created some other way
  }
}

function parseArgs(argv) {
  const out = { _: [], allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m') out.message = argv[++i];
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith('--') ? true : (i++, next);
      if (key === 'allow') out.allow.push(value);
      else out[key] = value;
    } else out._.push(a);
  }
  return out;
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function checkId(id) {
  if (!id || !/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id)) die(`invalid id: ${id ?? '(missing)'}`);
  return id;
}

function isUnder(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

function checkCwd(cwd, cfg) {
  const real = realOrResolve(expandHome(cwd));
  let st;
  try { st = fs.statSync(real); } catch { return { ok: false, real, why: `cwd does not exist: ${real}` }; }
  if (!st.isDirectory()) return { ok: false, real, why: `cwd is not a directory: ${real}` };
  // A task must never run where it could rewrite the queue, its tasks or this script.
  if (isUnder(realOrResolve(ROOT), real)) return { ok: false, real, why: `cwd cannot be inside the queue folder (${ROOT})` };
  if (isUnder(SCRIPT_DIR, real)) return { ok: false, real, why: `cwd cannot be inside the zq script folder (${SCRIPT_DIR})` };
  if (!cfg.allowed_roots.some((r) => isUnder(r, real)))
    return { ok: false, real, why: `cwd ${real} is outside allowed_roots (${cfg.allowed_roots.join(', ')})` };
  return { ok: true, real };
}

function readFrontMatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const meta = {};
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return meta;
}

function writeAtomic(file, content) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Oldest first: by file time, then by name (ids only have second precision).
const taskFiles = (dir) =>
  fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => {
      let t = 0;
      try { t = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
      return { f, t };
    })
    .sort((a, b) => a.t - b.t || a.f.localeCompare(b.f))
    .map((x) => x.f);

const paths = (id) => ({
  inbox: path.join(INBOX, `${id}.md`),
  working: path.join(WORKING, `${id}.md`),
  result: path.join(OUTBOX, `${id}.md`),
  files: path.join(OUTBOX, id),
  status: path.join(OUTBOX, `${id}.json`),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Serialises `claim` so overlapping Automation runs cannot exceed max_parallel together.
function withClaimLock(fn) {
  const lock = path.join(ROOT, '.claim.lock');
  for (let attempt = 0; attempt < 100; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        // A claim takes milliseconds; a lock older than 60 s was left by a crashed process.
        if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { force: true });
      } catch {}
      sleepSync(100);
      continue;
    }
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
  die('could not get the claim lock after 10 s; try again');
}

// Where a task is now. Checked in the order tasks move (inbox -> working -> outbox), and
// retried once, so a task that moves between two checks is not reported as unknown.
async function locate(id) {
  const p = paths(id);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (fs.existsSync(p.inbox)) return 'inbox';
    if (fs.existsSync(p.working)) return 'working';
    if (fs.existsSync(p.status)) return 'done';
    await sleep(200);
  }
  return null;
}

function readStatus(id) {
  try { return JSON.parse(fs.readFileSync(paths(id).status, 'utf8')); } catch { return null; }
}

function writeStatus(id, meta, status, summary, note) {
  const p = paths(id);
  const record = {
    id,
    status,
    summary: String(summary ?? '').trim(),
    ...(note ? { note } : {}),
    title: meta.title || '',
    cwd: meta.cwd || '',
    mode: meta.mode || '',
    submitted_at: meta.submitted_at || '',
    finished_at: new Date().toISOString(),
    result_file: fs.existsSync(p.result) ? p.result : null,
    files_dir: fs.existsSync(p.files) ? p.files : null,
  };
  writeAtomic(p.status, JSON.stringify(record, null, 2) + '\n');
  return record;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const ageMin = (file) => Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000);

function printDone(id) {
  const record = readStatus(id);
  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  if (record.result_file && fs.existsSync(record.result_file)) {
    process.stdout.write(`\n----- result: ${record.result_file} -----\n`);
    process.stdout.write(fs.readFileSync(record.result_file, 'utf8'));
    process.stdout.write('\n');
  }
  return record.status === 'done' ? 0 : 1;
}

function automationText() {
  const zq = `node ${SCRIPT}`;
  return `You are the worker for the task queue in ${ROOT}. Follow these steps exactly, then stop.

1. Run this command:
   ${zq} claim
   It prints JSON. If "claimed" is empty, reply "idle" and stop. Do nothing else.

2. For every item in "claimed", start one subagent. Start all of them in the same step, so they run in parallel. Wait until all of them have finished.
   Give each subagent this brief, with the values from its item:

   Your task is in the file <prompt_file>. Read it. The text after the front matter is your task.
   Work in this directory: <cwd>
   Mode: <mode>. If the mode is read-only, do not create, edit or delete files, and do not run commands that change anything. The only exception is the result files below.
   When you are done, write your complete final answer as Markdown to <result_file>.
   If you produce other files as output, put them in <files_dir>. Create that folder if needed.
   Reply with a one-line summary of what you did.

3. When a subagent has finished, run:
   ${zq} finish <id> --status done --summary "<one-line summary>"
   If the subagent failed or could not finish, use --status failed and give the reason in --summary.
   Keep the summary short and do not use double quotes in it.

4. Only run tasks that "zq claim" gives you. Do not read, change or delete any other files in ${ROOT}.
`;
}

// ---------- commands ----------

function init(args) {
  ensureDirs();
  const current = readConfigFile();
  const cfg = { ...DEFAULTS, ...(current ?? {}) };
  const roots = new Set((cfg.allowed_roots ?? []).map(String));
  for (const r of args.allow) {
    if (r === true) die('--allow needs a folder');
    const real = realOrResolve(expandHome(r));
    if (!fs.existsSync(real) || !fs.statSync(real).isDirectory()) die(`not a folder: ${real}`);
    roots.add(real);
  }
  cfg.allowed_roots = [...roots];
  if (!current || args.allow.length) writeAtomic(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  process.stdout.write(`queue: ${ROOT}\nconfig: ${CONFIG}\n${JSON.stringify(cfg, null, 2)}\n`);
  if (!cfg.allowed_roots.length) process.stdout.write('\nNo allowed_roots yet. Add one with: zq init --allow <folder>\n');
  else process.stdout.write('\nNext: run "zq automation" and paste its output into a new ZCode Automation.\n');
}

function automation() {
  process.stdout.write(automationText());
}

async function submit(args, cfg) {
  requireRoots(cfg);
  ensureDirs();
  const mode = args.mode || 'read-only';
  if (!MODES.includes(mode)) die(`--mode must be one of ${MODES.join(', ')}`);
  const cwd = checkCwd(args.cwd || process.cwd(), cfg);
  if (!cwd.ok) die(cwd.why);
  let prompt = args.message ?? (args.file ? fs.readFileSync(args.file, 'utf8') : await readStdin());
  prompt = String(prompt || '').trim();
  if (!prompt) die('empty prompt: pass -m TEXT, --file F, or pipe it on stdin');
  const title = String(args.title || prompt.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 100);
  const id = newId();
  const body =
    `---\nid: ${id}\ncwd: ${cwd.real}\nmode: ${mode}\ntitle: ${title}\nsubmitted_at: ${new Date().toISOString()}\n---\n\n${prompt}\n`;
  writeAtomic(paths(id).inbox, body);
  process.stdout.write(`${id}\n`);
}

function claim(args, cfg) {
  requireRoots(cfg);
  ensureDirs();
  withClaimLock(() => claimLocked(cfg));
}

function claimLocked(cfg) {
  const notes = [];
  // Recover stuck tasks: claimed long ago and never finished.
  for (const f of taskFiles(WORKING)) {
    const id = f.slice(0, -3);
    const file = path.join(WORKING, f);
    if (ageMin(file) >= cfg.stale_minutes && !fs.existsSync(paths(id).status)) {
      writeStatus(id, readFrontMatter(file), 'failed', `stale: no result after ${cfg.stale_minutes} minutes`);
      fs.rmSync(file, { force: true });
      notes.push(`marked stale task ${id} as failed`);
    }
  }
  const inFlight = taskFiles(WORKING).length;
  let free = Math.max(0, cfg.max_parallel - inFlight);
  const claimed = [];
  for (const f of taskFiles(INBOX)) {
    if (free <= 0) break;
    const id = f.slice(0, -3);
    const p = paths(id);
    try {
      fs.renameSync(p.inbox, p.working); // atomic: only one claimer wins
    } catch {
      continue;
    }
    const now = new Date();
    fs.utimesSync(p.working, now, now); // the stale clock starts at claim time
    const meta = readFrontMatter(p.working);
    const cwd = checkCwd(meta.cwd || '', cfg);
    if (!cwd.ok || !MODES.includes(meta.mode)) {
      writeStatus(id, meta, 'failed', cwd.ok ? `invalid mode: ${meta.mode}` : cwd.why);
      fs.rmSync(p.working, { force: true });
      notes.push(`rejected ${id}`);
      continue;
    }
    claimed.push({
      id,
      title: meta.title || '',
      cwd: cwd.real,
      mode: meta.mode,
      prompt_file: p.working,
      result_file: p.result,
      files_dir: p.files,
    });
    free--;
  }
  const out = {
    claimed,
    in_flight_before: inFlight,
    max_parallel: cfg.max_parallel,
    waiting_in_inbox: taskFiles(INBOX).length,
    notes,
  };
  if (!claimed.length) out.instruction = 'Nothing to do. Reply "idle" and stop.';
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function finish(args) {
  const id = checkId(args._[1]);
  const status = args.status;
  if (status !== 'done' && status !== 'failed') die('--status must be done or failed');
  const p = paths(id);
  const previous = readStatus(id);
  // After a stale timeout the task file is gone; keep the metadata from the earlier record.
  const meta = fs.existsSync(p.working) ? readFrontMatter(p.working) : previous ?? {};
  const summary = typeof args.summary === 'string' ? args.summary : '';
  const note = previous
    ? `finished late: it had already been marked ${previous.status} (${previous.summary})`
    : undefined;
  const record = writeStatus(id, meta, status, summary, note);
  fs.rmSync(p.working, { force: true });
  process.stdout.write(`finished ${id} (${record.status})${record.result_file ? '' : ' — warning: no result file was written'}\n`);
}

async function wait(args) {
  const id = checkId(args._[1]);
  const timeout = Number(args.timeout ?? 600) * 1000;
  const interval = Math.max(1, Number(args.interval ?? 5)) * 1000;
  const started = Date.now();
  for (;;) {
    const where = await locate(id);
    if (where === 'done') process.exit(printDone(id));
    if (!where) die(`unknown id: ${id}`, 3);
    if (Date.now() - started >= timeout) {
      process.stdout.write(`timeout: ${id} is still in ${where}/ after ${Math.round(timeout / 1000)}s\n`);
      process.exit(2);
    }
    await sleep(interval);
  }
}

async function result(args) {
  const id = checkId(args._[1]);
  const where = await locate(id);
  if (where === 'done') process.exit(printDone(id));
  if (!where) die(`unknown id: ${id}`, 3);
  process.stdout.write(`not finished: ${id} is in ${where}/\n`);
  process.exit(2);
}

function status(args, cfg) {
  ensureDirs();
  const line = (dir, f) => {
    const meta = readFrontMatter(path.join(dir, f));
    return `  ${f.slice(0, -3)}  ${String(ageMin(path.join(dir, f))).padStart(4)} min  ${meta.mode || '?'}  ${meta.title || ''}`;
  };
  const inbox = taskFiles(INBOX);
  const working = taskFiles(WORKING);
  process.stdout.write(`queue: ${ROOT}  (max_parallel ${cfg.max_parallel}, stale after ${cfg.stale_minutes} min)\n`);
  process.stdout.write(`inbox (${inbox.length}):\n${inbox.map((f) => line(INBOX, f)).join('\n') || '  -'}\n`);
  process.stdout.write(`working (${working.length}):\n${working.map((f) => line(WORKING, f)).join('\n') || '  -'}\n`);
  const recent = fs.readdirSync(OUTBOX)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)))
    .slice(0, Number(args.limit ?? 10));
  process.stdout.write(`finished (latest ${recent.length}):\n${recent.map((r) => `  ${r.id}  ${r.status.padEnd(6)}  ${r.title}${r.summary ? ` — ${r.summary}` : ''}`).join('\n') || '  -'}\n`);
}

function cancel(args) {
  const id = checkId(args._[1]);
  const p = paths(id);
  try {
    fs.rmSync(p.inbox);
    process.stdout.write(`cancelled ${id}\n`);
  } catch {
    if (fs.existsSync(p.working)) die(`${id} is already running; it cannot be cancelled`);
    die(`${id} is not waiting in the inbox`, 3);
  }
}

function prune(args) {
  ensureDirs();
  const days = Number(args.days ?? 7);
  if (!Number.isFinite(days) || days < 0) die('--days must be a number >= 0');
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  for (const f of fs.readdirSync(OUTBOX)) {
    const m = f.match(/^([0-9]{8}-[0-9]{6}-[0-9a-f]{4})\.json$/);
    if (!m) continue;
    const finished = Date.parse(readStatus(m[1])?.finished_at ?? '');
    if (!Number.isFinite(finished) || finished > cutoff) continue;
    const p = paths(m[1]);
    fs.rmSync(p.result, { force: true });
    fs.rmSync(p.files, { recursive: true, force: true });
    fs.rmSync(p.status, { force: true }); // last, so a half-pruned task still looks finished
    removed++;
  }
  process.stdout.write(`pruned ${removed} finished task(s) older than ${days} day(s)\n`);
}

const USAGE = `usage: zq <command> [options]

setup     init --allow DIR [--allow DIR ...]   create the queue (${ROOT}) and its config
          automation                           print the instructions for the ZCode Automation
producer  submit --cwd DIR [--mode read-only|edit] [--title T] (-m TEXT | --file F | stdin)
          wait ID [--timeout SEC] [--interval SEC]
          result ID | status [--limit N] | cancel ID | prune [--days N]
worker    claim | finish ID --status done|failed --summary TEXT

Set ZQ_ROOT to use another queue folder.
`;

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const cmd = args._[0];
const commands = { init, automation, submit, claim, finish, wait, result, status, cancel, prune };
if (!commands[cmd]) {
  process.stdout.write(USAGE);
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
await commands[cmd](args, cfg);
