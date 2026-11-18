// Live acceptance for the Hermes supervisor: asks it for work in chat and checks
// that the work shows up on the kanban board, runs, and can be tracked.
//
// This spends real model calls on the supervisor's provider and creates real
// kanban tasks, on a dedicated board only. It never starts a gateway, never
// touches the default board, and never touches OpenShell. Opt in explicitly:
//
//   SHELLGUARDIAN_SUPERVISOR_LIVE=1 node scripts/supervisor-acceptance.mjs
//
// Optional: SG_SUPERVISOR (default guanyu), SG_WORKER (default: the supervisor),
// SG_BOARD (default sg-acceptance), SG_SCENARIOS (e.g. "1,3"; default all),
// SG_KEEP=1 to leave the tasks on the board for inspection.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

if (process.env.SHELLGUARDIAN_SUPERVISOR_LIVE !== '1') {
  console.error('This spends real model calls. Set SHELLGUARDIAN_SUPERVISOR_LIVE=1 to run it.');
  process.exit(2);
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const supervisor = process.env.SG_SUPERVISOR ?? 'guanyu';
const worker = process.env.SG_WORKER ?? supervisor;
const board = process.env.SG_BOARD ?? 'sg-acceptance';
for (const [label, value] of [
  ['SG_SUPERVISOR', supervisor],
  ['SG_WORKER', worker],
  ['SG_BOARD', board],
]) {
  if (!NAME.test(value)) throw new Error(`${label} is not a valid name`);
}
if (board === 'default') throw new Error('Refusing to run on the default board');
const wanted = new Set((process.env.SG_SCENARIOS ?? '1,2,3,4').split(',').map((s) => s.trim()));
const marker = `sgacc-${randomBytes(3).toString('hex')}`;
const home = homedir();
// Cleared environment: provider keys exported in this shell must never reach Hermes.
const env = {
  HOME: home,
  USER: process.env.USER ?? '',
  PATH: `${join(home, '.local/bin')}:/usr/bin:/bin`,
  LANG: process.env.LANG ?? 'C.UTF-8',
  HERMES_INTERACTIVE: '1',
};
const tokens = { input: 0, output: 0, total: 0 };

function hermes(args, { timeout = 30_000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'hermes',
      args,
      { env, timeout, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (error.code ?? 1) : 0;
        if (error && !allowFail) {
          const last = String(stderr).trim().split('\n').at(-1) ?? '';
          reject(new Error(`hermes ${args.slice(0, 4).join(' ')} failed (${code}): ${last}`));
        } else resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.end();
  });
}

function parseJson(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in Hermes output');
  return JSON.parse(text.slice(start));
}
const kanban = async (...args) =>
  parseJson((await hermes(['kanban', `--board=${board}`, ...args, '--json'])).stdout);
const listTasks = () => kanban('list', '--archived');
const mine = async (suffix = '') =>
  (await listTasks()).filter((t) => String(t.title ?? '').includes(`${marker}${suffix}`));
const show = (id) => kanban('show', String(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(description, seconds, probe) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${seconds}s: ${description}`);
    await sleep(4000);
  }
}

/** One supervisor chat turn. Returns its final text and the tools it called. */
async function ask(prompt) {
  const { stdout } = await hermes(
    [
      '-p',
      supervisor,
      'chat',
      '-Q',
      '--format',
      'stream-json',
      '--max-turns',
      '12',
      `--query=${prompt}`,
    ],
    { timeout: 300_000, allowFail: true },
  );
  const events = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const result = events.findLast((e) => e.type === 'result');
  if (!result) throw new Error('the supervisor returned no result event');
  for (const key of Object.keys(tokens)) tokens[key] += Number(result.tokens?.[key] ?? 0);
  if (result.exit_code !== 0 || result.error)
    throw new Error(`supervisor turn failed: ${String(result.error ?? result.text).slice(0, 300)}`);
  return {
    text: String(result.text ?? ''),
    tools: events.filter((e) => e.type === 'tool_use').map((e) => e.name),
  };
}

const eventKinds = (detail) => (detail.events ?? []).map((e) => e.kind);
const rules = `Use the kanban board "${board}" (pass board="${board}" to kanban tools). `;

const scenarios = {
  1: {
    name: 'Single task is created, runs, completes, and is trackable',
    async run(notes) {
      await ask(
        `${rules}Create exactly one kanban task titled "${marker}-one haiku" assigned to ${worker}. ` +
          'The task: write a two-line haiku about sandboxes and put it in the task result. ' +
          'Do not write the haiku yourself in chat. Reply with the task id.',
      );
      const task = await until(
        'task appears on the board',
        90,
        async () => (await mine('-one'))[0],
      );
      if (task.assignee !== worker)
        throw new Error(`assignee is ${task.assignee}, wanted ${worker}`);
      notes.push(`task ${task.id} created by ${task.created_by ?? 'unknown'}`);
      let tracked = false;
      const done = await until('task reaches done', 600, async () => {
        const detail = await show(task.id);
        const kinds = eventKinds(detail);
        if (kinds.includes('owner_admitted') || kinds.includes('heartbeat')) tracked = true;
        const status = detail.task?.status;
        if (status === 'blocked')
          throw new Error(`task was blocked: ${detail.latest_summary ?? ''}`);
        return status === 'done' ? detail : null;
      });
      const kinds = eventKinds(done);
      for (const kind of ['claimed', 'completed'])
        if (!kinds.includes(kind)) throw new Error(`timeline has no "${kind}" event`);
      const result = String(done.task?.result ?? done.latest_summary ?? '').trim();
      if (!result) throw new Error('task finished with an empty result');
      if (!tracked)
        throw new Error('no owner_admitted or heartbeat event was visible during the run');
      const log = await hermes(
        ['kanban', `--board=${board}`, 'log', '--tail=2000', '--', String(task.id)],
        {
          allowFail: true,
        },
      );
      notes.push(`result: ${result.replace(/\s+/g, ' ').slice(0, 80)}`);
      notes.push(`worker log: ${log.stdout.trim() ? 'readable' : 'empty'}`);
    },
  },
  2: {
    name: 'Dependent task waits for its parent',
    async run(notes) {
      await ask(
        `${rules}Create two kanban tasks assigned to ${worker}. First "${marker}-dep A": reply with the single word ALPHA as the result. ` +
          `Second "${marker}-dep B": reply with the single word BETA as the result. B must depend on A (set A as its parent). Reply with both task ids.`,
      );
      const pair = await until('both tasks appear', 90, async () => {
        const found = await mine('-dep');
        return found.length >= 2 ? found : null;
      });
      const a = pair.find((t) => String(t.title).trim().endsWith('A'));
      const b = pair.find((t) => String(t.title).trim().endsWith('B'));
      if (!a || !b) throw new Error('could not tell the two tasks apart by title');
      const first = await show(b.id);
      if (!(first.parents ?? []).length) throw new Error('task B has no parent link');
      const aDone = (await show(a.id)).task?.status === 'done';
      if (!aDone && !['todo', 'triage'].includes(first.task?.status))
        throw new Error(`task B is ${first.task?.status} while A is unfinished`);
      const end = await until('both tasks reach done', 900, async () => {
        const [da, db] = await Promise.all([show(a.id), show(b.id)]);
        for (const d of [da, db])
          if (d.task?.status === 'blocked') throw new Error(`task ${d.task.id} was blocked`);
        return da.task?.status === 'done' && db.task?.status === 'done' ? [da, db] : null;
      });
      const [da, db] = end;
      if (Number(db.task.started_at) < Number(da.task.completed_at))
        throw new Error('task B started before task A completed');
      notes.push(`A ${a.id} finished before B ${b.id} started`);
    },
  },
  3: {
    name: 'A plain question creates no task',
    async run(notes) {
      const before = (await listTasks()).length;
      const reply = await ask(
        'What is 17 plus 25? Answer in one short sentence. This needs no task.',
      );
      if (!reply.text.includes('42'))
        throw new Error(`unexpected answer: ${reply.text.slice(0, 120)}`);
      if (reply.tools.includes('kanban_create'))
        throw new Error('the supervisor called kanban_create');
      await sleep(5000);
      const after = (await listTasks()).length;
      if (after !== before) throw new Error(`board went from ${before} to ${after} tasks`);
      notes.push('answered directly, board unchanged');
    },
  },
  4: {
    name: 'An impossible task is blocked, not marked done',
    async run(notes) {
      const missing = `/nonexistent/${marker}/input.txt`;
      await ask(
        `${rules}Create exactly one kanban task titled "${marker}-fail read file" assigned to ${worker}. ` +
          `The task: read the file ${missing} and put its exact contents in the result. ` +
          'If the file cannot be read, the task must be blocked with the reason, never completed. Reply with the task id.',
      );
      const task = await until(
        'task appears on the board',
        90,
        async () => (await mine('-fail'))[0],
      );
      const end = await until('task leaves the queue', 600, async () => {
        const detail = await show(task.id);
        const status = detail.task?.status;
        if (status === 'done') throw new Error('the impossible task was marked done');
        return eventKinds(detail).includes('blocked') || status === 'blocked' ? detail : null;
      });
      notes.push(`task ${task.id} ended ${end.task?.status}`);
    },
  },
};

async function preflight() {
  const attach = await hermes(['-p', supervisor, 'gateway', 'attach', '--json'], {
    allowFail: true,
  });
  let state = 'unknown';
  try {
    state = parseJson(attach.stdout).state;
  } catch {
    /* reported below */
  }
  if (attach.code !== 0)
    throw new Error(
      `${supervisor}'s Hermes gateway is ${state}. Start it in ShellGuardian (Supervisor → Agents → Start gateway), then run this again.`,
    );
  const boards = parseJson((await hermes(['kanban', 'boards', 'list', '--json'])).stdout);
  if (!boards.some((b) => b.slug === board)) {
    await hermes(['kanban', 'boards', 'create', '--name=ShellGuardian acceptance', '--', board]);
    console.log(`Created kanban board ${board}.`);
  }
}

async function cleanup() {
  if (process.env.SG_KEEP === '1') return;
  const ids = (await mine()).filter((t) => t.status !== 'archived').map((t) => String(t.id));
  if (ids.length)
    await hermes(['kanban', `--board=${board}`, 'archive', '--', ...ids], { allowFail: true });
}

const results = [];
try {
  await preflight();
  console.log(`Supervisor ${supervisor}, worker ${worker}, board ${board}, run ${marker}\n`);
  for (const [key, scenario] of Object.entries(scenarios)) {
    if (!wanted.has(key)) continue;
    const notes = [];
    const started = Date.now();
    process.stdout.write(`[${key}] ${scenario.name} … `);
    try {
      await scenario.run(notes);
      results.push({ key, name: scenario.name, ok: true, notes });
      console.log(`PASS (${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (error) {
      results.push({
        key,
        name: scenario.name,
        ok: false,
        notes: [...notes, String(error.message)],
      });
      console.log(`FAIL (${Math.round((Date.now() - started) / 1000)}s)`);
    }
    for (const note of results.at(-1).notes) console.log(`      ${note}`);
  }
} finally {
  await cleanup().catch((error) => console.error(`Cleanup failed: ${error.message}`));
}
const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} scenarios passed. ` +
    `Supervisor chat tokens: ${tokens.total} (in ${tokens.input}, out ${tokens.output}). ` +
    'Worker runs are not counted here.',
);
process.exit(failed || results.length === 0 ? 1 : 0);
