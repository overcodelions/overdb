// AI on the user's own CLI login.
//
// The invocation shape is lifted from overgit's src/main/cli.ts, which took
// it from overcli's reviewer.ts — the documented one-shot, prompt-on-stdin
// forms. That code is already right; only the prompts here are new.
//
// The deal this makes is the point of the feature: no API key, no
// subscription, no account. If you have `claude` installed and logged in,
// overdb uses it. If you don't, the AI surface hides rather than nagging.

import { spawn } from 'node:child_process';

export type AiTool = 'claude' | 'codex' | 'gemini';
export const AI_TOOLS: AiTool[] = ['claude', 'codex', 'gemini'];

/// Long enough for a real answer over a wide schema, short enough that a
/// wedged CLI doesn't leave the panel spinning forever.
const TIMEOUT_MS = 90_000;

export function probe(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { env: process.env });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

export async function detectTools(): Promise<Record<AiTool, boolean>> {
  const [claude, codex, gemini] = await Promise.all(AI_TOOLS.map((t) => probe(t)));
  return { claude, codex, gemini };
}

/// Every one of the three CLIs takes a model flag, which is what makes a
/// "fast tier" possible without a second provider: the same login, a cheaper
/// model, for the things that fire often. Only claude ships a stable short
/// alias, so the others default to empty (the CLI's own default) and are
/// overridable in Settings rather than guessed at — a wrong model name is a
/// hard error, and a broken default would be worse than no fast tier.
export const DEFAULT_FAST_MODELS: Record<AiTool, string> = {
  claude: 'haiku',
  codex: '',
  gemini: '',
};

function modelFlag(tool: AiTool, model: string): string[] {
  if (!model) return [];
  return tool === 'claude' ? ['--model', model] : ['-m', model];
}

function argsForTool(tool: AiTool): string[] {
  //   claude -p -   : print mode, prompt from stdin
  //   gemini -p -   : same shape
  //   codex exec -  : non-interactive exec; --skip-git-repo-check lets it
  //                   run from any cwd, which matters because overdb has no
  //                   repo of its own to sit in.
  switch (tool) {
    case 'claude':
    case 'gemini':
      return ['-p', '-'];
    case 'codex':
      return ['exec', '--skip-git-repo-check', '-'];
  }
}

/// codex interleaves its own section headers with the answer; keep only the
/// `codex` section, falling back to the raw text if the shape changes.
function extractCodexBody(raw: string): string {
  if (!raw) return '';
  const parts: string[] = [];
  let inCodex = false;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\[[^\]]+\]\s*([a-z_]+)\s*$/);
    if (m) {
      inCodex = m[1] === 'codex';
      continue;
    }
    if (inCodex) parts.push(line);
  }
  return parts.join('\n').trim() || raw.trim();
}

export interface AiResult {
  ok: boolean;
  output: string;
  error?: string;
  tool: AiTool;
}

export function runOneShot(
  tool: AiTool,
  prompt: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<AiResult> {
  return new Promise((resolve) => {
    const args = [...argsForTool(tool), ...modelFlag(tool, opts.model ?? '')];
    const child = spawn(tool, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: AiResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const seconds = Math.round((opts.timeoutMs ?? TIMEOUT_MS) / 1000);
      done({ ok: false, output: stdout, error: `${tool} took longer than ${seconds}s — aborted.`, tool });
    }, opts.timeoutMs ?? TIMEOUT_MS);

    child.stdout.on('data', (b) => (stdout += b.toString('utf-8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf-8')));
    child.on('error', () =>
      done({ ok: false, output: '', error: `${tool} is not installed or not on PATH.`, tool }),
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = tool === 'codex' ? extractCodexBody(stdout) : stdout.trim();
      if (code === 0 && body) done({ ok: true, output: body, tool });
      else done({ ok: false, output: body, error: stderr.trim() || `${tool} exited with ${code}`, tool });
    });

    // The CLI can exit on a bad --model before it drains stdin. Unlistened,
    // that EPIPE is an uncaught exception in the Electron main process.
    child.stdin.on('error', () => undefined);
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/// Pull fenced SQL out of a prose answer, so the Insert button has something
/// exact to put in the editor rather than the model's whole reply.
export function extractSql(markdown: string): string | null {
  const fenced = /```(?:sql)?\s*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(markdown))) blocks.push(m[1].trim());
  const best = blocks.filter(Boolean).sort((a, b) => b.length - a.length)[0];
  return best ?? null;
}

// ---- reading a repo, read-only ------------------------------------------
//
// The seed flow is the one place a model looks at more than a prompt: to
// seed data the app will actually accept it has to know what the schema
// cannot say — which strings a status column holds, what a JSON column
// looks like, which rules live only in code. So it runs inside the linked
// repo with file tools.
//
// Only claude, because only claude can be held to read-only file tools with
// no shell. That matters more than it sounds: a repo usually holds a `.env`
// with the database's own credentials, and an agent with a shell could
// connect to the database directly and walk straight past the write gate.
// codex's read-only sandbox still runs shell commands, and gemini's plan
// mode is not a tool list — so both stay schema-only in this flow.
//
// What the arguments below guarantee, each on its own:
//   --tools            the only tools that exist are Read, Grep and Glob
//   --restricted       code-running tools gone, file tools confined to the
//                      repo, the user's and the repo's settings ignored
//   --strict-mcp-config  no MCP servers, so no database MCP either
//   --disallowedTools  Read denied on dotenv files (Grep and Glob honour it)
//   --permission-mode dontAsk  anything that would prompt is refused
// `src/main/seedNeverExecutes.test.ts` fails if any of these goes missing.

/// The only tools the investigation may use.
export const INVESTIGATE_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/// Everything after `claude`. `=` forms throughout: the variadic options
/// would otherwise swallow the arguments after them.
export function investigateArgs(model: string): string[] {
  return [
    '-p',
    '-',
    '--output-format=stream-json',
    '--verbose',
    `--tools=${INVESTIGATE_TOOLS.join(',')}`,
    '--restricted',
    '--strict-mcp-config',
    '--disallowedTools=Read(./.env*),Read(./**/.env*),Read(./**/*.pem),Read(./**/*.key)',
    '--permission-mode=dontAsk',
    '--no-session-persistence',
    ...modelFlag('claude', model),
  ];
}

export interface InvestigationStep {
  kind: 'read' | 'grep' | 'glob' | 'note';
  text: string;
}

/// One line of stream-json, reduced to what the log shows: which file was
/// read, what was searched for. Never a file's contents.
export function stepsFromStreamLine(line: string, cwd: string): InvestigationStep[] {
  let event: { type?: string; message?: { content?: unknown } };
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  const rel = (p: unknown) => {
    const s = typeof p === 'string' ? p : '';
    return s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s;
  };
  const steps: InvestigationStep[] = [];
  for (const part of event.message!.content as Array<Record<string, unknown>>) {
    if (part.type !== 'tool_use') continue;
    const input = (part.input ?? {}) as Record<string, unknown>;
    if (part.name === 'Read') steps.push({ kind: 'read', text: rel(input.file_path) });
    else if (part.name === 'Grep') {
      const where = input.path ? ` in ${rel(input.path)}` : input.glob ? ` in ${String(input.glob)}` : '';
      steps.push({ kind: 'grep', text: `"${String(input.pattern ?? '')}"${where}` });
    } else if (part.name === 'Glob') steps.push({ kind: 'glob', text: String(input.pattern ?? '') });
  }
  return steps;
}

/// The final answer out of a stream-json transcript: the `result` event.
export function resultFromStream(stdout: string): { ok: boolean; text: string } | null {
  const lines = stdout.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]) as { type?: string; result?: unknown; is_error?: boolean };
      if (event.type === 'result') {
        return { ok: !event.is_error, text: typeof event.result === 'string' ? event.result : '' };
      }
    } catch {
      /* a partial line */
    }
  }
  return null;
}

export interface Investigation {
  result: Promise<AiResult>;
  cancel(): void;
}

export function runInvestigation(
  prompt: string,
  opts: { cwd: string; model?: string; timeoutMs?: number; onStep: (step: InvestigationStep) => void },
): Investigation {
  const child = spawn('claude', investigateArgs(opts.model ?? ''), { cwd: opts.cwd, env: process.env });
  let stdout = '';
  let stderr = '';
  let pending = '';
  let settled = false;
  let resolveResult: (r: AiResult) => void = () => undefined;
  const result = new Promise<AiResult>((resolve) => (resolveResult = resolve));
  const done = (r: AiResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveResult(r);
  };
  const kill = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  };

  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const timer = setTimeout(() => {
    kill();
    done({ ok: false, output: '', error: `claude took longer than ${Math.round(timeoutMs / 60_000)} minutes — aborted.`, tool: 'claude' });
  }, timeoutMs);

  child.stdout.on('data', (b) => {
    const chunk = b.toString('utf-8');
    stdout += chunk;
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) for (const step of stepsFromStreamLine(line, opts.cwd)) opts.onStep(step);
  });
  child.stderr.on('data', (b) => (stderr += b.toString('utf-8')));
  child.on('error', () => done({ ok: false, output: '', error: 'claude is not installed or not on PATH.', tool: 'claude' }));
  child.on('close', (code) => {
    const final = resultFromStream(stdout);
    if (code === 0 && final?.ok && final.text) done({ ok: true, output: final.text, tool: 'claude' });
    else {
      // An older claude without one of the flags above fails here, and says
      // which: better an error naming `--restricted` than a quieter
      // investigation with a shell in it.
      done({
        ok: false,
        output: final?.text ?? '',
        error: stderr.trim() || final?.text || `claude exited with ${code}`,
        tool: 'claude',
      });
    }
  });
  child.stdin.on('error', () => undefined);
  child.stdin.write(prompt);
  child.stdin.end();

  return {
    result,
    cancel() {
      kill();
      done({ ok: false, output: '', error: 'Stopped.', tool: 'claude' });
    },
  };
}
