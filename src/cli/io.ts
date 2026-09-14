/**
 * The CLI's terminal boundary (SPEC-013 `terminalOutput`): stdout for results; stderr for errors, warnings and prompts.
 * Commands never touch process.stdout, process.stderr or process.stdin themselves, so tests drive main() with a
 * captured CliIo.
 */
import { createInterface } from 'node:readline';

export interface CliIo {
  /** Where the command runs. The store is the one of the git worktree containing this directory. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Shows `question` on stderr; resolves with the next input line without its line terminator, or '' at end of input. */
  prompt(question: string): Promise<string>;
  /** All of stdin as UTF-8, or '' when stdin is a terminal. */
  readStdin(): Promise<string>;
}

function promptLine(question: string): Promise<string> {
  process.stderr.write(`${question} `);
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, terminal: false });
    let settled = false;
    const settle = (answer: string): void => {
      if (settled) return;
      settled = true;
      lines.close();
      resolve(answer);
    };
    lines.once('line', settle);
    lines.once('close', () => settle(''));
  });
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** The real terminal. */
export function processIo(): CliIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    prompt: promptLine,
    readStdin: readAllStdin,
  };
}
