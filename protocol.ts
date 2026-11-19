import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { request } from 'node:http';
import { join } from 'node:path';

export const workerDirKey = 'PI_HERDR_SUBAGENT_DIR';
export const maxPromptBytes = 48 * 1024;
export const startupMs = 60_000;

export type WorkerStatus =
  'starting' | 'running' | 'blocked' | 'completed' | 'failed' | 'aborted';
const usageFields = [
  ['input', '↑'],
  ['output', '↓'],
  ['cacheRead', 'cr:'],
  ['cacheWrite', 'cw:'],
] as const;
type UsageField = (typeof usageFields)[number][0];
export type Usage = { tokens: number; cost: number } & Partial<
  Record<UsageField, number>
>;
export type WorkerSnapshot = {
  status: WorkerStatus;
  output: string;
  sessionFile?: string;
  usage: Usage;
};

export const active = (status: string) =>
  status === 'starting' || status === 'running' || status === 'blocked';
export const isWorkerDir = (dir: string) =>
  /^\/tmp\/pi-subagent-[a-zA-Z0-9]{6}$/.test(dir);
export const socketPath = (dir: string) => join(dir, 'worker.sock');
export const shellQuote = (value: string) =>
  `'${value.replaceAll("'", "'\\''")}'`;

export function addUsage(total: Usage, usage: Usage) {
  total.tokens += usage.tokens;
  total.cost += usage.cost;
  for (const [field] of usageFields) {
    const count = usage[field];
    if (count !== undefined) total[field] = (total[field] ?? 0) + count;
  }
}

function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatUsage(usage: Usage): string {
  const fields: string[] = [];
  let legacyTokens = usage.tokens;
  for (const [field, label] of usageFields) {
    const count = usage[field];
    if (count === undefined) continue;
    fields.push(`${label}${formatTokenCount(count)}`);
    legacyTokens -= count;
  }
  if (!fields.length) fields.push(`tokens:${formatTokenCount(legacyTokens)}`);
  else if (legacyTokens > 0)
    fields.push(`legacy:${formatTokenCount(legacyTokens)}`);
  fields.push(`$${usage.cost.toFixed(4)}`);
  return fields.join(' · ');
}

export function sessionUsage(
  session: ExtensionContext['sessionManager'],
): Usage {
  const total: Usage = {
    tokens: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const entry of session.getEntries()) {
    const usage =
      entry.type === 'message'
        ? entry.message.role === 'assistant' ||
          entry.message.role === 'toolResult'
          ? entry.message.usage
          : undefined
        : entry.type === 'usage' ||
            entry.type === 'compaction' ||
            entry.type === 'branch_summary'
          ? entry.usage
          : undefined;
    if (!usage) continue;
    const { input, output, cacheRead, cacheWrite, cost } = usage;
    addUsage(total, {
      tokens: input + output + cacheRead + cacheWrite,
      cost: cost.total,
      input,
      output,
      cacheRead,
      cacheWrite,
    });
  }
  return total;
}

export function settledResult(
  message: AssistantMessage | undefined,
  aborted: boolean,
) {
  const text =
    message?.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n') ?? '';
  if (aborted || message?.stopReason === 'aborted')
    return { status: 'aborted', output: text || 'Worker aborted.' } as const;
  if (!message || message.stopReason === 'error') {
    return {
      status: 'failed',
      output:
        message?.errorMessage ||
        text ||
        'Pi settled without an assistant response.',
    } as const;
  }
  return {
    status: 'completed',
    output: text || 'Pi settled without a text response.',
  } as const;
}

export function workerRequest(
  dir: string,
  prompt?: string,
): Promise<WorkerSnapshot> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socketPath(dir),
        path: prompt === undefined ? '/' : '/prompt',
        method: prompt === undefined ? 'GET' : 'POST',
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (res.statusCode === 200) resolve(result);
            else
              reject(
                new Error(result.error || `Worker HTTP ${res.statusCode}`),
              );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(3000, () =>
      req.destroy(new Error('Worker did not respond.')),
    );
    req.on('error', reject);
    req.end(prompt);
  });
}
