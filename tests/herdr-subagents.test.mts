import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  addUsage,
  formatUsage,
  isWorkerDir,
  sessionUsage,
  settledResult,
  shellQuote,
  socketPath,
  workerRequest,
} from '../protocol.ts';

test('escape prompt text for a POSIX shell without executing substitutions', () => {
  const prompt = "'quoted'\n$(echo unexpected) `echo unexpected` $HOME\n";
  const result = execFileSync('sh', ['-c', `printf %s ${shellQuote(prompt)}`], {
    encoding: 'utf8',
  });
  assert.equal(result, prompt);
  assert.equal(isWorkerDir('/tmp/pi-subagent-aT9psC'), true);
  assert.equal(isWorkerDir('/tmp/pi-subagent-aT9psC/../other'), false);
});

test('sum persisted assistant, extension, and compaction usage', () => {
  const usage = {
    input: 4,
    output: 3,
    cacheRead: 5,
    cacheWrite: 6,
    cost: { total: 0.25 },
  };
  const session = {
    getEntries: () => [
      { type: 'message', message: { role: 'assistant', usage } },
      { type: 'message', message: { role: 'toolResult', usage } },
      { type: 'message', message: { role: 'toolResult' } },
      { type: 'usage', usage },
      { type: 'compaction', usage },
      { type: 'branch_summary', usage },
      { type: 'custom', data: { usage } },
    ],
  } as unknown as ExtensionContext['sessionManager'];
  assert.deepEqual(sessionUsage(session), {
    tokens: 90,
    cost: 1.25,
    input: 20,
    output: 15,
    cacheRead: 25,
    cacheWrite: 30,
  });
});

test('format separate token counts and retain legacy usage', () => {
  const usage = { tokens: 1200, cost: 0.01 };
  assert.equal(formatUsage(usage), 'tokens:1.2k · $0.0100');

  const splitUsage = {
    tokens: 1_233_508,
    cost: 0.0496,
    input: 8,
    output: 1_600,
    cacheRead: 1_200_000,
    cacheWrite: 31_900,
  };
  assert.equal(
    formatUsage(splitUsage),
    '↑8 · ↓1.6k · cr:1.2M · cw:32k · $0.0496',
  );
  addUsage(usage, splitUsage);
  assert.equal(
    formatUsage(usage),
    '↑8 · ↓1.6k · cr:1.2M · cw:32k · legacy:1.2k · $0.0596',
  );
});

test('distinguish successful, failed, and aborted Pi runs', () => {
  const message = {
    stopReason: 'stop',
    content: [
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'text', text: 'Worker output' },
    ],
  } as AssistantMessage;
  assert.deepEqual(settledResult(message, false), {
    status: 'completed',
    output: 'Worker output',
  });
  assert.deepEqual(
    settledResult(
      { ...message, stopReason: 'error', errorMessage: 'No model' },
      false,
    ),
    { status: 'failed', output: 'No model' },
  );
  assert.equal(settledResult(undefined, true).status, 'aborted');
  assert.equal(settledResult(undefined, false).status, 'failed');
});

test('query status and surface follow-up rejection through a Unix socket', async () => {
  const dir = await mkdtemp('/tmp/pi-subagent-');
  const output = {
    status: 'completed',
    output: 'Result',
    usage: { tokens: 8, cost: 0.001 },
  };
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.end(JSON.stringify(output));
      return;
    }
    let prompt = '';
    for await (const chunk of req.setEncoding('utf8')) prompt += chunk;
    if (
      req.method === 'POST' &&
      req.url === '/prompt' &&
      prompt === 'Try again'
    ) {
      res.writeHead(409).end(JSON.stringify({ error: 'Worker is busy.' }));
    } else {
      res.writeHead(400).end(JSON.stringify({ error: 'Unexpected request.' }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) =>
      server.once('error', reject).listen(socketPath(dir), resolve),
    );
    assert.deepEqual(await workerRequest(dir), output);
    await assert.rejects(workerRequest(dir, 'Try again'), /Worker is busy/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
  await assert.rejects(workerRequest(dir), { code: 'ENOENT' });
});
