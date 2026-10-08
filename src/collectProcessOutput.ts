import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ExecResult } from "./SandboxProvider.js";
import { BoundedTail } from "./boundedTail.js";

export const collectProcessOutput = (
  proc: ChildProcess,
  options: {
    stdin?: string;
    onLine?: (line: string) => void;
    maxOutputTailChars: number;
    errorPrefix: string;
  },
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    if (options.stdin !== undefined) {
      proc.stdin!.write(options.stdin);
      proc.stdin!.end();
    }

    proc.on("error", (error) => {
      reject(new Error(`${options.errorPrefix}: ${error.message}`));
    });

    if (options.onLine) {
      const onLine = options.onLine;
      const stdoutTail = new BoundedTail(options.maxOutputTailChars, "\n");
      const stderrTail = new BoundedTail(options.maxOutputTailChars, "");
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        stdoutTail.push(line);
        onLine(line);
      });
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrTail.push(chunk.toString());
      });
      proc.on("close", (code) => {
        resolve({
          stdout: stdoutTail.toString(),
          stderr: stderrTail.toString(),
          exitCode: code ?? 0,
        });
      });
    } else {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      proc.stdout!.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk.toString());
      });
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });
      proc.on("close", (code) => {
        resolve({
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          exitCode: code ?? 0,
        });
      });
    }
  });
