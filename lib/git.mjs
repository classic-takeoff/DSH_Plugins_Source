/** Git helpers bound to one working directory. */
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Capture git output through temporary files instead of pipes, so the helper also works in
 * sandboxes that forbid piped stdio. `run` keeps stdin/stdout attached for interactive steps.
 */
export function useGit(cwd) {
  function git(args) {
    const stamp = `${String(process.pid)}-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
    const stdoutFile = path.join(os.tmpdir(), `dsh-git-${stamp}.out`);
    const stderrFile = path.join(os.tmpdir(), `dsh-git-${stamp}.err`);
    const stdoutFd = fsSync.openSync(stdoutFile, 'w');
    const stderrFd = fsSync.openSync(stderrFile, 'w');
    let status = 0;
    try {
      execFileSync('git', args, { cwd, stdio: ['ignore', stdoutFd, stderrFd] });
    } catch (error) {
      status = error.status ?? 1;
    } finally {
      fsSync.closeSync(stdoutFd);
      fsSync.closeSync(stderrFd);
    }
    const stdout = fsSync.readFileSync(stdoutFile, 'utf8').trim();
    const stderr = fsSync.readFileSync(stderrFile, 'utf8').trim();
    fsSync.rmSync(stdoutFile, { force: true });
    fsSync.rmSync(stderrFile, { force: true });
    if (status !== 0) throw new Error(stderr === '' ? `git ${args.join(' ')} failed with exit code ${String(status)}` : stderr);
    return stdout;
  }

  function gitOrNull(args) {
    try {
      return git(args);
    } catch {
      return undefined;
    }
  }

  function run(command, args) {
    execFileSync(command, args, { cwd, stdio: 'inherit' });
  }

  return { git, gitOrNull, run };
}
