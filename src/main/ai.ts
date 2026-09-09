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
