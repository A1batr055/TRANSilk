import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import url from "node:url";

export const TOOL_ROOT = path.dirname(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))));
export const RUNTIME_TEMP_ROOT = path.join(TOOL_ROOT, ".runtime", "temp");

export function runtimeTempDir(prefix) {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(RUNTIME_TEMP_ROOT, `${prefix}-`));
}

export function runtimeTempFile(prefix, extension) {
  fs.mkdirSync(RUNTIME_TEMP_ROOT, { recursive: true });
  return path.join(RUNTIME_TEMP_ROOT, `${prefix}-${crypto.randomUUID()}${extension}`);
}

export function workDirFor(projectDir) {
  const projectName = path.basename(path.resolve(projectDir));
  const dir = path.join(TOOL_ROOT, "work", projectName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectSubdir(projectDir, name) {
  return path.join(projectDir, name);
}
