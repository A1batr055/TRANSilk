import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runCliProcess } from "../src/lib/cliProcess.mjs";
import { runtimeTempDir } from "../src/lib/paths.mjs";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("CLI process timeout rejects and terminates the process tree", async (t) => {
  const tempDir = runtimeTempDir("cli-timeout-test");
  const pidFile = path.join(tempDir, "pid.txt");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  await assert.rejects(
    runCliProcess(process.execPath, [path.join(process.cwd(), "test-support", "hanging-process.cjs"), pidFile], {
      cwd: process.cwd(),
      timeoutMs: 1000,
      errorLabel: "测试进程",
    }),
    /测试进程超时/,
  );

  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 20 && processExists(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(processExists(pid), false);
});
