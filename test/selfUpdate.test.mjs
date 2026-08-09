import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkForUpdates, inspectForUpdates } from "../src/lib/selfUpdate.mjs";
import { RUNTIME_TEMP_ROOT } from "../src/lib/paths.mjs";

function createInstall(t, name) {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, `${name}-`));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "package-lock.json"), "old-lock\n", "utf8");
  fs.writeFileSync(path.join(root, "node_modules", "old.txt"), "old dependencies\n", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeGit(root, { changeLock = true, dirty = "" } = {}) {
  let updated = false;
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "status") return dirty;
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return updated ? "new-head" : "old-head";
    if (args[0] === "rev-parse") return "new-head";
    if (args[0] === "merge-base") return "old-head";
    if (args[0] === "pull") {
      updated = true;
      if (changeLock) fs.writeFileSync(path.join(root, "package-lock.json"), "new-lock\n", "utf8");
      return "";
    }
    if (args[0] === "reset" && args[1] === "--hard") {
      updated = false;
      fs.writeFileSync(path.join(root, "package-lock.json"), "old-lock\n", "utf8");
      return "";
    }
    throw new Error(`未处理的 git 调用：${args.join(" ")}`);
  };
  return { calls, run };
}

test("automatic inspection reports an available update without pulling it", async () => {
  const calls = [];
  const result = await inspectForUpdates({
    runGitImpl: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "old-head";
      if (args[0] === "rev-parse") return "new-head";
      if (args[0] === "merge-base") return "old-head";
      throw new Error(`未处理的 git 调用：${args.join(" ")}`);
    },
  });
  assert.equal(result.status, "available");
  assert.equal(calls.some((call) => call.startsWith("pull ")), false);
});

test("safe update stops before fetching when tracked source files are dirty", async (t) => {
  const root = createInstall(t, "transilk-update-dirty");
  const git = fakeGit(root, { dirty: " M src/tui.mjs" });
  await assert.rejects(
    checkForUpdates({ toolRoot: root, runGitImpl: git.run, runProcessImpl: async () => {} }),
    /未提交的源码改动/,
  );
  assert.deepEqual(git.calls, ["status --porcelain --untracked-files=no"]);
});

test("safe update replaces dependencies only after a lock-file change and validates startup", async (t) => {
  const root = createInstall(t, "transilk-update-success");
  const git = fakeGit(root);
  const processCalls = [];
  const result = await checkForUpdates({
    toolRoot: root,
    runGitImpl: git.run,
    runProcessImpl: async (command) => {
      processCalls.push(command);
      if (command === "npm") {
        fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
        fs.writeFileSync(path.join(root, "node_modules", "new.txt"), "new dependencies\n", "utf8");
      }
    },
  });
  assert.equal(result.status, "updated");
  assert.match(result.message, /同步依赖/);
  assert.deepEqual(processCalls, ["npm", process.execPath]);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "old.txt")), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "new.txt")), true);
  assert.equal(fs.existsSync(path.join(root, ".runtime", "update-backup")), false);
});

test("safe update restores the old commit and dependencies when installation fails", async (t) => {
  const root = createInstall(t, "transilk-update-rollback");
  const git = fakeGit(root);
  await assert.rejects(
    checkForUpdates({
      toolRoot: root,
      runGitImpl: git.run,
      runProcessImpl: async (command) => {
        if (command !== "npm") return;
        fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
        fs.writeFileSync(path.join(root, "node_modules", "partial.txt"), "partial dependencies\n", "utf8");
        throw new Error("依赖下载失败");
      },
    }),
    /已恢复到更新前版本/,
  );
  assert.equal(git.calls.includes("reset --hard old-head"), true);
  assert.equal(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"), "old-lock\n");
  assert.equal(fs.existsSync(path.join(root, "node_modules", "old.txt")), true);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "partial.txt")), false);
  assert.equal(fs.existsSync(path.join(root, ".runtime", "update-backup")), false);
});

test("safe update restores the old commit when the updated program cannot start", async (t) => {
  const root = createInstall(t, "transilk-update-smoke-rollback");
  const git = fakeGit(root, { changeLock: false });
  await assert.rejects(
    checkForUpdates({
      toolRoot: root,
      runGitImpl: git.run,
      runProcessImpl: async () => { throw new Error("启动检查失败"); },
    }),
    /已恢复到更新前版本/,
  );
  assert.equal(git.calls.includes("reset --hard old-head"), true);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "old.txt")), true);
});

test("safe update skips dependency installation when the lock file is unchanged", async (t) => {
  const root = createInstall(t, "transilk-update-no-deps");
  const git = fakeGit(root, { changeLock: false });
  const processCalls = [];
  const result = await checkForUpdates({
    toolRoot: root,
    runGitImpl: git.run,
    runProcessImpl: async (command) => processCalls.push(command),
  });
  assert.equal(result.status, "updated");
  assert.deepEqual(processCalls, [process.execPath]);
  assert.equal(fs.existsSync(path.join(root, "node_modules", "old.txt")), true);
});
