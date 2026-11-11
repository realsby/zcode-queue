// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZQ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'zq.mjs');

// Every test gets its own queue folder and its own allowed work folder.
function setup({ maxParallel = 2, staleMinutes = 90 } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zq-test-')));
  const root = path.join(base, 'queue');
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  const env = { ...process.env, ZQ_ROOT: root };
  const zq = (args, input) => {
    const r = spawnSync(process.execPath, [ZQ, ...args], { env, input, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  assert.equal(zq(['init', '--allow', work]).code, 0);
  const cfgFile = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, max_parallel: maxParallel, stale_minutes: staleMinutes }));
  const submit = (text, extra = []) => {
    const r = zq(['submit', '--cwd', work, '-m', text, ...extra]);
    assert.equal(r.code, 0, r.err);
    return r.out.trim();
  };
  const claim = () => JSON.parse(zq(['claim']).out);
  return { base, root, work, env, zq, submit, claim };
}

test('submit refuses to run before init sets allowed_roots', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-test-'));
  const r = spawnSync(process.execPath, [ZQ, 'submit', '--cwd', base, '-m', 'x'], {
    env: { ...process.env, ZQ_ROOT: path.join(base, 'queue') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no allowed_roots/);
});

test('claim hands out at most max_parallel tasks, oldest first', () => {
  const q = setup();
  const ids = ['one', 'two', 'three'].map((t) => q.submit(t));
  const first = q.claim();
  assert.deepEqual(first.claimed.map((c) => c.id), ids.slice(0, 2));
  assert.equal(first.waiting_in_inbox, 1);
  assert.equal(q.claim().claimed.length, 0, 'both slots are busy');
  assert.equal(q.zq(['finish', ids[0], '--status', 'done', '--summary', 'ok']).code, 0);
  assert.deepEqual(q.claim().claimed.map((c) => c.id), [ids[2]]);
});

test('parallel claims never exceed max_parallel together', async () => {
  const q = setup();
  for (let i = 0; i < 6; i++) q.submit(`task ${i}`);
  const runs = Array.from({ length: 5 }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, [ZQ, 'claim'], { env: q.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(JSON.parse(out).claimed.length));
  }));
  const total = (await Promise.all(runs)).reduce((a, b) => a + b, 0);
  assert.equal(total, 2);
  assert.equal(fs.existsSync(path.join(q.root, '.claim.lock')), false);
});

test('cwd must be inside allowed_roots and never inside the queue or the script folder', () => {
  const q = setup();
  assert.match(q.zq(['submit', '--cwd', os.tmpdir(), '-m', 'x']).err, /outside allowed_roots/);
  assert.match(q.zq(['submit', '--cwd', q.root, '-m', 'x']).err, /inside the queue folder/);
  // Allow the folder that holds the script, then try to run a task in the script's own folder.
  const scriptDir = fs.realpathSync(path.dirname(ZQ));
  q.zq(['init', '--allow', path.dirname(scriptDir)]);
  assert.match(q.zq(['submit', '--cwd', scriptDir, '-m', 'x']).err, /inside the zq script folder/);
});

test('wait and result report done, failed, unknown and timeout with distinct exit codes', () => {
  const q = setup();
  const done = q.submit('done task');
  const failed = q.submit('failed task');
  q.claim();
  fs.writeFileSync(path.join(q.root, 'outbox', `${done}.md`), '# answer\n');
  q.zq(['finish', done, '--status', 'done', '--summary', 'answered']);
  q.zq(['finish', failed, '--status', 'failed', '--summary', 'broke']);
  const ok = q.zq(['wait', done, '--timeout', '1']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /# answer/);
  assert.equal(q.zq(['result', failed]).code, 1);
  assert.equal(q.zq(['result', '20990101-000000-abcd']).code, 3);
  const pending = q.submit('still waiting');
  assert.equal(q.zq(['wait', pending, '--timeout', '1', '--interval', '1']).code, 2);
  assert.equal(fs.existsSync(path.join(q.root, 'working', `${done}.md`)), false, 'finish removes the task file');
});

test('a stuck task is marked failed and frees its slot; a late finish keeps its metadata', () => {
  const q = setup({ maxParallel: 1 });
  const slow = q.submit('slow task', ['--title', 'Slow']);
  const next = q.submit('next task');
  q.claim();
  const old = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(path.join(q.root, 'working', `${slow}.md`), old, old);
  const c = q.claim();
  assert.deepEqual(c.claimed.map((x) => x.id), [next]);
  assert.match(c.notes[0], /stale/);
  q.zq(['finish', slow, '--status', 'done', '--summary', 'finally']);
  const record = JSON.parse(fs.readFileSync(path.join(q.root, 'outbox', `${slow}.json`), 'utf8'));
  assert.equal(record.status, 'done');
  assert.equal(record.title, 'Slow');
  assert.match(record.note, /finished late/);
});

test('cancel works only while a task waits in the inbox', () => {
  const q = setup({ maxParallel: 1 });
  const running = q.submit('a');
  const waiting = q.submit('b');
  q.claim();
  assert.equal(q.zq(['cancel', waiting]).code, 0);
  assert.match(q.zq(['cancel', running]).err, /already running/);
});

test('prune deletes finished tasks older than --days', () => {
  const q = setup();
  const oldId = q.submit('old');
  const newId = q.submit('new');
  q.claim();
  for (const id of [oldId, newId]) q.zq(['finish', id, '--status', 'done', '--summary', 's']);
  const file = path.join(q.root, 'outbox', `${oldId}.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, finished_at: '2000-01-01T00:00:00.000Z' }));
  assert.match(q.zq(['prune', '--days', '7']).out, /pruned 1/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(q.root, 'outbox', `${newId}.json`)), true);
});

test('automation prints worker instructions with this script\'s absolute path', () => {
  const q = setup();
  const out = q.zq(['automation']).out;
  assert.ok(out.includes(`node ${fs.realpathSync(ZQ)} claim`));
  assert.ok(out.includes(q.root));
});

test('queue folders are private', () => {
  const q = setup();
  for (const d of ['', 'inbox', 'working', 'outbox']) {
    assert.equal(fs.statSync(path.join(q.root, d)).mode & 0o777, 0o700, `${d || 'root'} should be 700`);
  }
});

test('balance reads the newest balance the ZCode app logged', () => {
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-logs-'));
  const entry = (time, remaining) =>
    `[${time}] [info] [usage-stats] billing/balance request done ` +
    JSON.stringify({ balances: [{ total_units: 500000000, remaining_units: remaining }],
      payload: { data: { plans: [{ name: 'WEEKEND', ends_at: 1794186000 }] } } });
  fs.writeFileSync(path.join(logs, '2026-11-07.log'), entry('2026-11-07 22:00:00.000', 150000000) + '\n');
  fs.writeFileSync(path.join(logs, '2026-11-08.log'),
    [entry('2026-11-08 13:00:00.000', 16000000), '[2026-11-08 13:05:00.000] other line', '[x] billing/balance {cut off'].join('\n'));
  const run = (dir) => spawnSync(process.execPath, [ZQ, 'balance', '--json'],
    { env: { ...process.env, ZQ_ZCODE_LOGS: dir }, encoding: 'utf8' });
  const r = run(logs);
  assert.equal(r.status, 0, r.stderr);
  const b = JSON.parse(r.stdout);
  assert.equal(b.percent, 3.2);
  assert.equal(b.at, '2026-11-08 13:00:00');
  assert.equal(b.plans[0].ends_at, '2026-11-09T01:00:00.000Z');
  assert.equal(run(path.join(logs, 'missing')).status, 2);

  // a plan that ended: the app logs an empty balance, which means 0% left
  fs.appendFileSync(path.join(logs, '2026-11-08.log'),
    '\n[2026-11-08 14:00:00.000] [info] [usage-stats] billing/balance done {"balances":[],"payload":{"data":{"plans":[]}}}');
  const ended = JSON.parse(run(logs).stdout);
  assert.equal(ended.percent, 0);
  assert.equal(ended.at, '2026-11-08 14:00:00');

  // the app switched to the Individual Coding Plan after that: its balance is unknown, not 0
  fs.appendFileSync(path.join(logs, '2026-11-08.log'),
    '\n[2026-11-08 15:00:00.000] [info] provider runtime headers {"providerId":"account:zai-individual-coding-plan"}');
  const coding = JSON.parse(run(logs).stdout);
  assert.equal(coding.percent, null);
  assert.equal(coding.plan, 'individual-coding-plan');

  // a balance check right after a Coding Plan session is still "unknown", not 0%
  fs.appendFileSync(path.join(logs, '2026-11-08.log'),
    '\n[2026-11-08 15:10:00.000] [info] [usage-stats] billing/balance done {"balances":[],"payload":{"data":{"plans":[]}}}');
  assert.equal(JSON.parse(run(logs).stdout).percent, null);
});

test('balance treats a pool past its expiry as 0% left', () => {
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-logs-'));
  const entry = (time, expires) =>
    `[${time}] [info] [usage-stats] billing/balance done ` +
    JSON.stringify({ balances: [{ total_units: 300000000, remaining_units: 190000000, expires_at: expires }] });
  const run = () => JSON.parse(spawnSync(process.execPath, [ZQ, 'balance', '--json'],
    { env: { ...process.env, ZQ_ZCODE_LOGS: logs }, encoding: 'utf8' }).stdout);
  fs.writeFileSync(path.join(logs, '2026-11-11.log'), entry('2026-11-11 01:22:00.000', 4102444800) + '\n');
  assert.equal(run().percent, 63.3); // expires in 2100: still counts
  fs.writeFileSync(path.join(logs, '2026-11-11.log'), entry('2026-11-11 01:22:00.000', 1700000000) + '\n');
  assert.equal(run().percent, 0); // expired: the tokens left in it are gone

  // the app's real shape: the date is only in payload.data (plan ends_at, bucket expires_at)
  const nested = (expires) =>
    '[2026-11-11 01:22:42.002] [info] [usage-stats] billing/balance done ' +
    JSON.stringify({
      balances: [{ entitlement_id: 'ent-1', total_units: 300000000, remaining_units: 190000000 }],
      payload: { data: { plans: [{ name: 'BUILD', ends_at: expires, entitlements: [{ entitlement_id: 'ent-1' }] }] } },
    });
  fs.writeFileSync(path.join(logs, '2026-11-11.log'), nested(4102444800) + '\n');
  assert.equal(run().percent, 63.3);
  fs.writeFileSync(path.join(logs, '2026-11-11.log'), nested(1700000000) + '\n');
  assert.equal(run().percent, 0);
});
