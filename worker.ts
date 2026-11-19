import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  truncateHead,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  active,
  isWorkerDir,
  maxPromptBytes,
  sessionUsage,
  settledResult,
  socketPath,
  startupMs,
  workerDirKey,
  type WorkerSnapshot,
} from './protocol.ts';

export default function (pi: ExtensionAPI) {
  const dir = process.env[workerDirKey];
  if (!dir || !isWorkerDir(dir)) return;

  let result: Pick<WorkerSnapshot, 'status' | 'output'> = {
    status: 'starting',
    output: '',
  };
  let startedAt = Date.now();
  let waitingForUser = false;
  let lastAssistant: AssistantMessage | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'startup') return;
    const snapshot = (): WorkerSnapshot => {
      if (
        !waitingForUser &&
        result.status === 'starting' &&
        Date.now() - startedAt >= startupMs
      ) {
        result = {
          status: 'failed',
          output:
            'Pi did not start the prompt. Check the worker tab for an error.',
        };
      }
      const truncated = truncateHead(result.output, {
        maxBytes: 16 * 1024,
        maxLines: 200,
      });
      const sessionFile = ctx.sessionManager.getSessionFile();
      return {
        status: waitingForUser ? 'blocked' : result.status,
        output:
          truncated.content +
          (truncated.truncated
            ? '\n[Output truncated. See worker tab or session for full text.]'
            : ''),
        sessionFile,
        usage: sessionUsage(ctx.sessionManager),
      };
    };

    const workerServer = createServer(async (req, res) => {
      const reply = (status: number, data: object) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && req.url === '/') {
        reply(200, snapshot());
        return;
      }
      if (req.method !== 'POST' || req.url !== '/prompt') {
        reply(404, { error: 'Unknown worker request.' });
        return;
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > maxPromptBytes) {
            reply(413, { error: 'Prompt exceeds 48 KiB.' });
            return;
          }
          chunks.push(chunk);
        }
      } catch {
        return;
      }
      const prompt = Buffer.concat(chunks).toString('utf8');
      if (!prompt.trim()) {
        reply(400, { error: 'Prompt must not be empty.' });
        return;
      }
      if (waitingForUser || !ctx.isIdle() || active(snapshot().status)) {
        reply(409, {
          error: 'Worker is busy. Wait for it to settle or open its tab.',
        });
        return;
      }
      result = { status: 'starting', output: '' };
      startedAt = Date.now();
      lastAssistant = undefined;
      pi.sendUserMessage(prompt, { expandPromptTemplates: false });
      reply(200, snapshot());
    });
    server = workerServer;
    workerServer.requestTimeout = 3000;
    await new Promise<void>((resolve, reject) => {
      workerServer.once('error', reject);
      workerServer.listen(socketPath(dir), () => {
        workerServer.off('error', reject);
        resolve();
      });
    });
  });

  pi.on('before_agent_start', () => {
    result = { status: 'starting', output: '' };
    startedAt = Date.now();
    lastAssistant = undefined;
  });
  pi.on('agent_start', () => {
    result = { status: 'running', output: '' };
  });
  pi.on('turn_end', (event) => {
    if (event.message.role === 'assistant') lastAssistant = event.message;
  });
  pi.on('agent_end', (event) => {
    const assistant = event.messages.findLast(
      (message) => message.role === 'assistant',
    );
    if (assistant?.role === 'assistant') lastAssistant = assistant;
  });
  pi.on('agent_settled', (event) => {
    result = settledResult(lastAssistant, event.aborted);
  });
  pi.on('ui_prompt_start', () => {
    waitingForUser = true;
  });
  pi.on('ui_prompt_end', () => {
    waitingForUser = false;
  });
  pi.on('session_shutdown', async () => {
    if (!server) return;
    const workerServer = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      workerServer.close(() => resolve());
      workerServer.closeAllConnections();
    });
    await rm(dir, { recursive: true, force: true });
  });
}
