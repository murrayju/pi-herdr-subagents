# Pi Herdr Subagents

Run subagents in named [Herdr](https://herdr.dev) tabs instead of splitting your screen. Each subagent is a separate, interactive [Pi](https://pi.dev) session. The parent can keep working while its workers run, and you can open a worker's tab at any time to watch, answer a prompt, or take over.

```text
Agents: 1/2 · ↑8 · ↓1.6k · cr:1.2M · cw:32k · $0.0496
```

The footer shows running/completed counts, input and output tokens, cache reads and writes, and estimated worker spend. Each worker also has a live transcript card with its status and latest answer. Click the card in fullscreen Pi, use `/subagents` to pick a tab, or run `/subagents <id>` to jump directly to it.

## Install

Requires interactive Pi inside Herdr, both `pi` and `herdr` on `PATH`, a POSIX shell, and a writable `/tmp`. Tested with Pi 1.5.2 and Herdr 0.9.5 on Linux.

**Install as a Pi package:**

```sh
pi install git:github.com/murrayju/pi-herdr-subagents
```

**Or clone into Pi's global extensions:**

```sh
git clone https://github.com/murrayju/pi-herdr-subagents.git \
  "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/herdr-subagents"
```

Choose one method, not both. [murrayju/dotfiles](https://github.com/murrayju/dotfiles) uses the clone method. The extension uses Pi's own libraries, so the clone does not need an `npm install` step.

Start Pi inside Herdr, or run `/reload` in an open parent session. Update a Pi package install with `pi update --extensions`; update a clone with `git pull --ff-only`, then reload the parent again.

## Use it

Ask Pi to delegate a task in plain language:

> Start a subagent named `review-auth` to review the auth changes. Turn off Advisor for the reviewer, and ask it not to edit files. Keep working while it runs.

> Follow up with `review-auth` and ask it to check the session cookie flags. Wait for its answer, then close its tab.

A worker defaults to the parent's model, thinking level, and working directory. The worker has its own conversation, **not its own checkout**. Give concurrent writers separate worktrees and pass each worktree as the worker's `cwd`.

### Tool reference

The parent gets one tool, `herdr_subagent`:

| Action | Parameters | Result |
| --- | --- | --- |
| `start` | `name`, `prompt`; optional `model`, `cwd`, `advisor` | Launch Pi in a named background tab and return a worker ID. |
| `list` | None | Show counts and total usage, plus details for the newest 100 workers. |
| `status` | `id` | Read the latest state, response, usage, and Pi session file. |
| `wait` | `id`; optional `timeoutSeconds` (1 to 600, default 120) | Wait until the worker settles, blocks, disconnects, or times out. |
| `send` | `id`, `prompt` | Start another turn in the same idle worker. |
| `close` | `id` | Close only the original pane of a worker that confirms it is idle. |

Pass an exact `provider/model` ID to select a different model. Use `advisor: false` to exclude the Advisor tools and gates for a reviewer. Prompts must be nonempty and at most 48 KiB.

For example, in Pi's `codemode` tool:

```js
const subagent = async (args) => JSON.parse(await tools.herdr_subagent(args));
const worker = await subagent({
  action: 'start',
  name: 'review-auth',
  prompt: 'Review the auth changes. Report bugs and test gaps. Do not edit files.',
  advisor: false,
});
const result = await subagent({ action: 'wait', id: worker.id, timeoutSeconds: 300 });
return result;
```

A wait timeout or Escape stops the **wait**, not the worker. Check `status` or wait again before retrying a prompt. `completed` means Pi finished responding without an error, not that the task succeeded. Read the output and verify the work before acting on it.

## Sessions and usage

- **Status travels over private Unix sockets.** No signal files or terminal scraping. The parent restores worker cards from its session entries and reconnects to reachable workers when it reloads or resumes in the same Herdr session.
- **Workers stay open.** Exiting the parent does not close them. Reloading or replacing a worker's Pi session detaches it from tracking. Its tab stays usable. If a worker is blocked on a dialog or you want to stop it mid-task, open its tab.
- **The full response stays in the worker.** Expand Pi's tool output to read more of the card. The parent keeps up to 200 lines or 16 KiB of the answer. Open the worker tab or its Pi session file for the rest.
- **The cost is an estimate.** The footer totals the usage that Pi reports for the workers in the current session branch, including retained totals for closed workers. It does not include the parent's own usage and can differ from your provider's bill.

## Development

Run `npm test` with Node.js 22.18 or newer. There are no packages to install before running the tests. To try a checkout without installing it, run `pi -e ./index.ts` inside Herdr with any other copy disabled.

[MIT license](LICENSE)
