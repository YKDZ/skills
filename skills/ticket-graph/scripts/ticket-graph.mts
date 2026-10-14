#!/usr/bin/env node
import { cli } from "./contracts.mts";
import type { Effects } from "./types.ts";
import {
  CliWriteError,
  executeCli,
  parseCliInvocation,
  nodeCliOutput,
} from "./vendor/cli-contract.mjs";

const effects: Effects = {
  configCreated: false,
  configSaved: false,
  ticketSaved: false,
  historySaved: false,
};
const write = nodeCliOutput({ stdout: process.stdout, stderr: process.stderr });
try {
  const termination = await executeCli(cli, {
    invocation: parseCliInvocation(cli, process.argv.slice(2)),
    dependencies: { effects },
    write,
  });
  process.exitCode = termination.exitCode;
} catch (error) {
  process.exitCode = 1;
  const diagnostic = {
    error: {
      code: error instanceof CliWriteError ? "OUTPUT_FAILED" : "INTERNAL_ERROR",
      message:
        error instanceof CliWriteError
          ? "结果未完整输出；已发生的修改仍然有效。"
          : "命令执行异常。",
      ...(error instanceof Error ? { cause: error.message } : {}),
    },
    effects,
  };
  try {
    await write({
      destination: "stderr",
      chunk: `${JSON.stringify(diagnostic)}\n`,
    });
  } catch {
    /* 标准错误也不可写时，保留失败退出码。 */
  }
}
