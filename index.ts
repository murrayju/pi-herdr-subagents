import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  Box,
  MouseRegion,
  Text,
  stripTerminalSequences,
} from '@earendil-works/pi-tui';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import {
  active,
  addUsage,
  formatUsage,
  isWorkerDir,
  maxPromptBytes,
  shellQuote,
  startupMs,
  workerDirKey,
  workerRequest,
  type WorkerSnapshot,
} from './protocol.ts';

const cardType = 'herdr-subagent';
const snapshotType = 'herdr-subagent-snapshot';
const workerExtension = fileURLToPath(new URL('./worker.ts', import.meta.url));
const serverSocket = process.env.HERDR_SOCKET_PATH;
const workspace = process.env.HERDR_WORKSPACE_ID;

type Pane = { pane_id: string; tab_id: string; terminal_id: string };
type Worker = Omit<WorkerSnapshot, 'status'> & {
  id: string;
  name: string;
  model: string;
  pane: Pane;
  dir: string;
  server: string;
  launchedAt: number;
  status: WorkerSnapshot['status'] | 'disconnected';
  connected: boolean;
  closed?: boolean;
};

const clean = (text: string) =>
  stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const usageText = ({ tokens, cost }: Worker['usage']) =>
  `${tokens.toLocaleString()} tokens · $${cost.toFixed(4)}`;

function summarize(workers: Worker[]) {
  let running = 0;
  let completed = 0;
  let blocked = 0;
  const usage = { tokens: 0, cost: 0 };
  for (const worker of workers) {
    if (worker.status === 'blocked') blocked++;
    else if (active(worker.status)) running++;
    else if (worker.status === 'completed') completed++;
    addUsage(usage, worker.usage);
  }
  return {
    running,
    completed,
    blocked,
    other: workers.length - running - completed - blocked,
    usage,
  };
}

export default function (pi: ExtensionAPI) {
  if (
    process.env[workerDirKey] ||
    process.env.HERDR_ENV !== '1' ||
    !workspace ||
    !serverSocket
  )
    return;

  const workers = new Map<string, Worker>();
  const mutations = new Set<string>();
  let session: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;

  async function herdr<T = void>(...args: string[]): Promise<T> {
    const { code, stdout, stderr } = await pi.exec('herdr', args, {
      timeout: 5000,
    });
    if (code !== 0)
      throw new Error(
        stderr.trim() || `Herdr ${args.slice(0, 2).join(' ')} failed.`,
      );
    return (stdout.trim() ? JSON.parse(stdout).result : undefined) as T;
  }

  async function paneGone(worker: Worker) {
    try {
      const { pane } = await herdr<{ pane: Pane }>(
        'pane',
        'get',
        worker.pane.pane_id,
      );
      return pane.terminal_id !== worker.pane.terminal_id;
    } catch (error) {
      return /"code"\s*:\s*"pane_not_found"/.test(String(error));
    }
  }

  function updateFooter() {
    const list = [...workers.values()];
    const { running, completed, usage } = summarize(list);
    session?.ui.setStatus(
      cardType,
      list.length
        ? `Agents: ${running}/${completed} · ${formatUsage(usage)}`
        : undefined,
    );
  }

  function save(worker: Worker, change: Partial<Worker>) {
    const next = { ...worker, ...change };
    if (
      !session ||
      workers.get(worker.id) !== worker ||
      JSON.stringify(next) === JSON.stringify(worker)
    )
      return;
    workers.set(next.id, next);
    pi.appendEntry(snapshotType, next);
    updateFooter();
  }

  async function refresh(worker: Worker) {
    if (
      worker.closed ||
      mutations.has(worker.id) ||
      worker.server !== serverSocket
    )
      return;
    let change: Partial<Worker>;
    try {
      change = { ...(await workerRequest(worker.dir)), connected: true };
    } catch {
      change = { connected: false };
      const gone = active(worker.status) && (await paneGone(worker));
      if (gone) await rm(worker.dir, { recursive: true, force: true });
      if (
        active(worker.status) &&
        (worker.connected ||
          gone ||
          Date.now() - worker.launchedAt >= startupMs)
      ) {
        change.status = 'disconnected';
        change.output =
          'Cannot reach Pi in this tab. Open the tab to check startup, trust prompts, or errors.';
      }
    }
    if (!mutations.has(worker.id)) save(worker, change);
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await Promise.all([...workers.values()].map(refresh));
    } finally {
      polling = false;
    }
  }

  function restore(ctx: ExtensionContext) {
    workers.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type !== 'custom' ||
        (entry.customType !== cardType && entry.customType !== snapshotType)
      )
        continue;
      const worker = entry.data as Worker | undefined;
      if (
        worker?.id &&
        isWorkerDir(worker.dir) &&
        worker.id === basename(worker.dir).slice('pi-subagent-'.length)
      ) {
        const sameServer = worker.server === serverSocket;
        workers.set(
          worker.id,
          sameServer
            ? worker
            : {
                ...worker,
                connected: false,
                ...(active(worker.status)
                  ? {
                      status: 'disconnected',
                      output:
                        'This worker belongs to a different Herdr session.',
                    }
                  : {}),
              },
        );
      }
    }
    updateFooter();
    void poll();
  }

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    session = ctx;
    restore(ctx);
    timer = setInterval(() => {
      void poll();
    }, 1500);
  });
  pi.on('session_tree', (_event, ctx) => {
    if (session) restore(ctx);
  });
  pi.on('session_shutdown', () => {
    clearInterval(timer);
    session = undefined;
    workers.clear();
  });

  async function ownedPane(worker: Worker): Promise<Pane> {
    if (worker.server !== serverSocket || worker.closed)
      throw new Error(
        'This worker tab is not available in the current Herdr session.',
      );
    const { pane } = await herdr<{ pane: Pane }>(
      'pane',
      'get',
      worker.pane.pane_id,
    );
    if (pane.terminal_id !== worker.pane.terminal_id)
      throw new Error('Herdr no longer has the original worker terminal.');
    return pane;
  }

  async function focus(worker: Worker) {
    const pane = await ownedPane(worker);
    await herdr('tab', 'focus', pane.tab_id);
  }

  async function focusForUser(worker: Worker, ctx: ExtensionContext) {
    try {
      await focus(worker);
    } catch (error) {
      ctx.ui.notify(clean(String(error)), 'warning');
    }
  }

  pi.registerEntryRenderer<Worker>(cardType, (entry, options, theme) => {
    const original = entry.data;
    if (!original) return undefined;
    const current = () => workers.get(original.id) ?? original;
    const component = {
      render(width: number) {
        const worker = current();
        const connection = worker.closed
          ? ' (closed)'
          : !worker.connected && !active(worker.status)
            ? ' (offline)'
            : '';
        const status = worker.status + connection;
        const box = new Box(1, 0, (line) => theme.bg('customMessageBg', line));
        const title = `Subagent: ${worker.name} [${worker.id}] · ${status}`;
        box.addChild(new Text(theme.fg('accent', title), 0, 0));
        box.addChild(
          new Text(
            theme.fg(
              'muted',
              usageText(worker.usage) +
                (worker.closed
                  ? ''
                  : ` · Click or /subagents ${worker.id} to open`),
            ),
            0,
            0,
          ),
        );
        if (worker.output) {
          const output = clean(worker.output);
          const preview = output
            .split('\n')
            .slice(0, 3)
            .join('\n')
            .slice(0, 360);
          box.addChild(
            new Text(
              options.expanded || preview === output
                ? output
                : `${preview}\n${options.keyHint('app.tools.expand', 'to expand')}`,
              0,
              0,
            ),
          );
        }
        return box.render(width);
      },
      invalidate() {},
    };
    return new MouseRegion(component, (event) => {
      if (
        event.type !== 'click' ||
        event.button !== 'left' ||
        !session ||
        current().closed
      )
        return;
      void focusForUser(current(), session);
      return { handled: true };
    });
  });

  pi.registerCommand('subagents', {
    description: 'Pick a worker tab or open it by ID: /subagents [id]',
    async handler(args, ctx) {
      const id = args.trim();
      const labels = new Map(
        [...workers.values()]
          .filter((worker) => !worker.closed)
          .map((w) => [`${w.id}  ${w.name} (${w.status})`, w]),
      );
      if (!id && !labels.size) {
        ctx.ui.notify('This session has no open subagent tabs.', 'info');
        return;
      }
      const choice =
        id || (await ctx.ui.select('Open subagent tab', [...labels.keys()]));
      if (!choice) return;
      const worker = workers.get(choice) ?? labels.get(choice);
      if (worker) await focusForUser(worker, ctx);
      else ctx.ui.notify(`Unknown subagent: ${choice}`, 'warning');
    },
  });

  function validatePrompt(prompt: string | undefined) {
    if (
      !prompt?.trim() ||
      prompt.includes('\0') ||
      Buffer.byteLength(prompt) > maxPromptBytes
    ) {
      throw new Error(
        'Provide a nonempty prompt of at most 48 KiB without NUL characters.',
      );
    }
    return prompt;
  }

  async function launch(
    params: {
      name?: string;
      prompt?: string;
      model?: string;
      cwd?: string;
      advisor?: boolean;
    },
    ctx: ExtensionContext,
  ) {
    const prompt = validatePrompt(params.prompt);
    const name = params.name?.trim();
    if (!name || name.length > 64 || clean(name).replace(/\s+/g, ' ') !== name)
      throw new Error('Provide a short tab name on one line.');
    const model =
      params.model ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
    if (
      !model ||
      (!ctx.modelRegistry
        .getAll()
        .some((entry) => `${entry.provider}/${entry.id}` === model) &&
        model !== `${ctx.model?.provider}/${ctx.model?.id}`)
    ) {
      throw new Error('Provide an exact configured provider/model ID.');
    }
    const cwd = resolve(ctx.cwd, params.cwd ?? '.');
    if (!(await stat(cwd)).isDirectory())
      throw new Error(`Not a directory: ${cwd}`);
    const dir = await mkdtemp('/tmp/pi-subagent-');
    const id = basename(dir).slice('pi-subagent-'.length);
    const runner = join(dir, 'launch.sh');
    let worker: Worker | undefined;
    try {
      const args = [
        '--extension',
        workerExtension,
        '--name',
        name,
        '--model',
        model,
        '--thinking',
        pi.getThinkingLevel(),
      ];
      if (params.advisor === false)
        args.push('--exclude-tools', 'ask_advisor,record_advisor_outcome');
      args.push('--', `Subagent assignment:\n${prompt}`);
      if (process.env.PI_OFFLINE === '1') args.unshift('--offline');
      const env = [
        `${workerDirKey}=${dir}`,
        `PI_CODING_AGENT_DIR=${getAgentDir()}`,
      ];
      await writeFile(
        runner,
        `rm -f -- "$0"\nexec env ${[...env, 'pi', ...args].map(shellQuote).join(' ')}\n`,
        { mode: 0o600 },
      );
      const { root_pane: pane } = await herdr<{ root_pane: Pane }>(
        'tab',
        'create',
        '--workspace',
        workspace!,
        '--cwd',
        cwd,
        '--label',
        name,
        '--no-focus',
      );
      worker = {
        id,
        name,
        model,
        pane,
        dir,
        server: serverSocket!,
        launchedAt: Date.now(),
        status: 'starting',
        connected: false,
        output: '',
        usage: { tokens: 0, cost: 0 },
      };
      workers.set(id, worker);
      pi.appendEntry(cardType, worker);
      updateFooter();
      await herdr('pane', 'run', pane.pane_id, `exec sh ${shellQuote(runner)}`);
      return worker;
    } catch (error) {
      if (worker) {
        // Herdr can accept a launch even if the client loses its response.
        save(worker, { output: clean(String(error)) });
        return workers.get(id) ?? worker;
      }
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  function publicWorker({
    id,
    name,
    model,
    status,
    connected,
    closed,
    output,
    sessionFile,
    usage,
    pane,
  }: Worker) {
    return {
      id,
      name,
      model,
      status,
      connected,
      closed,
      output,
      sessionFile,
      usage,
      tab: pane.tab_id,
    };
  }

  pi.registerTool({
    name: 'herdr_subagent',
    label: 'Herdr subagents',
    description:
      'Manage independent Pi sessions in named Herdr tabs. Start returns immediately. Wait returns at settle, block, disconnect, or timeout; retry waits, not sends. Completed means Pi finished responding, not that the task passed. Send reuses an idle worker. Close removes only the original inactive worker pane. Work is not isolated from the shared checkout.',
    promptSnippet:
      'Start, inspect, wait for, or follow up with named Pi subagents in Herdr tabs.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('start'),
        Type.Literal('list'),
        Type.Literal('status'),
        Type.Literal('wait'),
        Type.Literal('send'),
        Type.Literal('close'),
      ]),
      id: Type.Optional(
        Type.String({
          description: 'Worker ID for status, wait, send, or close.',
        }),
      ),
      name: Type.Optional(Type.String({ description: 'Tab name for start.' })),
      prompt: Type.Optional(
        Type.String({
          description:
            'Assignment for start or follow-up for send, at most 48 KiB.',
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            'Exact provider/model ID for start. Defaults to the current model.',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            'Working directory for start. Defaults to the current directory.',
        }),
      ),
      advisor: Type.Optional(
        Type.Boolean({
          description:
            'Set false for a reviewer to exclude Advisor tools and gates. Defaults to the installed Advisor settings.',
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 600,
          description:
            'Wait timeout. Defaults to 120 seconds. A timeout does not stop the worker.',
        }),
      ),
    }),
    async execute(_callId, params, signal, _onUpdate, ctx) {
      if (!session)
        throw new Error('Herdr subagents require interactive Pi inside Herdr.');
      const reply = (value: object) => ({
        content: [
          { type: 'text' as const, text: JSON.stringify(value, null, 2) },
        ],
        details: undefined,
      });
      if (params.action === 'start')
        return reply(publicWorker(await launch(params, ctx)));
      if (params.action === 'list') {
        const list = [...workers.values()];
        return reply({
          ...summarize(list),
          omitted: Math.max(0, list.length - 100),
          workers: list.slice(-100).map((worker) => ({
            ...publicWorker(worker),
            output: undefined,
            sessionFile: undefined,
          })),
        });
      }
      const getWorker = () => {
        const worker = params.id && workers.get(params.id);
        if (!worker)
          throw new Error('Provide a worker ID from herdr_subagent list.');
        return worker;
      };
      let worker = getWorker();
      if (params.action === 'status') return reply(publicWorker(worker));
      if (params.action === 'wait') {
        const deadline = Date.now() + 1000 * (params.timeoutSeconds ?? 120);
        while (worker.status === 'starting' || worker.status === 'running') {
          signal?.throwIfAborted();
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            return reply({ ...publicWorker(worker), timedOut: true });
          await delay(Math.min(500, remaining), undefined, { signal });
          worker = getWorker();
        }
        return reply(publicWorker(worker));
      }

      if (mutations.has(worker.id))
        throw new Error('Another operation is in progress for this worker.');
      mutations.add(worker.id);
      try {
        if (params.action === 'send') {
          if (
            !worker.connected ||
            worker.server !== serverSocket ||
            worker.closed
          )
            throw new Error(
              'Worker is not available. Wait for it to start or open its tab to inspect it.',
            );
          save(worker, {
            ...(await workerRequest(worker.dir, validatePrompt(params.prompt))),
            connected: true,
          });
        } else {
          const pane = await ownedPane(worker);
          const latest = await workerRequest(worker.dir).catch(() => undefined);
          if (!latest || active(latest.status))
            throw new Error(
              'Cannot confirm the worker is idle. Open its tab to inspect or stop it.',
            );
          await herdr('pane', 'close', pane.pane_id);
          save(worker, { ...latest, closed: true, connected: false });
          await rm(worker.dir, { recursive: true, force: true });
        }
        return reply(publicWorker(getWorker()));
      } finally {
        mutations.delete(worker.id);
      }
    },
  });
}
