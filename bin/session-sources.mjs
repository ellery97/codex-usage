import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const WINDOWS_ROOT_ENV = "CODEX_USAGE_WINDOWS_ROOT";
const WSL_DISTROS_ENV = "CODEX_USAGE_WSL_DISTROS";
const SKIP_WINDOWS_USER_DIRS = new Set(["All Users", "Default", "Default User", "Public"]);

const nativeFs = {
  exists: existsSync,
  directories(root) {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  },
};

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function expandHome(inputPath, platform, env) {
  if (!inputPath) return inputPath;
  const api = pathApi(platform);
  const home = platform === "win32"
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || env.USERPROFILE || homedir();
  if (inputPath === "~") return home;
  if (inputPath.startsWith("~/")) return api.join(home, inputPath.slice(2));
  return inputPath;
}

export function normalizeSourceDirs(dirs, { platform = process.platform } = {}) {
  const api = pathApi(platform);
  const seen = new Set();
  const normalized = [];
  for (const dir of dirs || []) {
    if (!dir) continue;
    const resolved = api.resolve(String(dir));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

function safeExists(fsApi, target) {
  try {
    return Boolean(fsApi.exists(target));
  } catch {
    return false;
  }
}

function safeDirectories(fsApi, root) {
  try {
    return fsApi.directories(root);
  } catch {
    return [];
  }
}

function addCodexSessionDirs(
  target,
  codexHome,
  fsApi,
  { includeArchived = true, platform = process.platform } = {},
) {
  const api = pathApi(platform);
  for (const name of includeArchived ? ["sessions", "archived_sessions"] : ["sessions"]) {
    const dir = api.join(codexHome, name);
    if (safeExists(fsApi, dir)) target.push(dir);
  }
}

export function windowsUsersRoot({ platform = process.platform, env = process.env } = {}) {
  if (env[WINDOWS_ROOT_ENV]) return env[WINDOWS_ROOT_ENV];
  if (platform !== "win32") return "/mnt/c/Users";

  const api = path.win32;
  const profile = env.USERPROFILE ||
    (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : "");
  if (profile) return api.dirname(profile);
  return api.join(env.SystemDrive || env.HOMEDRIVE || "C:", "Users");
}

export function windowsUserName({ platform = process.platform, env = process.env } = {}) {
  if (env.CODEX_USAGE_WINDOWS_USER) return env.CODEX_USAGE_WINDOWS_USER;
  if (env.USERNAME) return env.USERNAME;
  if (env.USER) return env.USER;
  const api = pathApi(platform);
  const profile = env.USERPROFILE || (env.HOME ? env.HOME : "");
  return profile ? api.basename(profile) : "windows-user";
}

export function defaultWindowsSessionDirs(options = {}) {
  return discoverWindowsSessionDirs(options);
}

export function discoverWindowsSessionDirs({
  platform = process.platform,
  env = process.env,
  fs = nativeFs,
} = {}) {
  const api = pathApi(platform);
  const root = windowsUsersRoot({ platform, env });
  let profiles = safeDirectories(fs, root).filter((name) => !SKIP_WINDOWS_USER_DIRS.has(name));
  if (profiles.length === 0) profiles = [windowsUserName({ platform, env })];

  const dirs = [];
  for (const profile of profiles) {
    addCodexSessionDirs(dirs, api.join(root, profile, ".codex"), fs, { platform });
  }
  return normalizeSourceDirs(dirs, { platform });
}

function localCodexHome({ platform, env, codexHome }) {
  const api = pathApi(platform);
  const home = platform === "win32"
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || env.USERPROFILE || homedir();
  return expandHome(
    codexHome || env.CODEX_HOME || api.join(home, ".codex"),
    platform,
    env,
  );
}

function configuredList(value, delimiter) {
  return String(value || "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeDistroName(value) {
  return value && value !== "." && value !== ".." && !/[\\/]/.test(value) ? value : null;
}

function decodeWslList(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ""));
  const text = buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8");
  return text
    .split(/\r?\n/)
    .map((line) => safeDistroName(line.replace(/^\uFEFF/, "").trim()))
    .filter(Boolean);
}

export function listWslDistros({
  env = process.env,
  execFile = execFileSync,
} = {}) {
  const configured = configuredList(env[WSL_DISTROS_ENV], ";")
    .map(safeDistroName)
    .filter(Boolean);
  if (configured.length > 0) return [...new Set(configured)];

  try {
    return [...new Set(decodeWslList(execFile("wsl.exe", ["-l", "-q"], {
      encoding: "buffer",
      windowsHide: true,
    })))];
  } catch {
    return [];
  }
}

function wslUncRoots(distro) {
  return [
    path.win32.join("\\\\wsl.localhost", distro).replace(/[\\]+$/, ""),
    path.win32.join("\\\\wsl$", distro).replace(/[\\]+$/, ""),
  ];
}

function accessibleWslRoot(distro, fsApi) {
  return wslUncRoots(distro).find((root) => safeExists(fsApi, root)) || null;
}

function discoverWslFromWindows({ env, fs, execFile }) {
  const dirs = [];
  for (const distro of listWslDistros({ env, execFile })) {
    const root = accessibleWslRoot(distro, fs);
    if (!root) continue;

    const homeRoot = path.win32.join(root, "home");
    for (const user of safeDirectories(fs, homeRoot)) {
      addCodexSessionDirs(dirs, path.win32.join(homeRoot, user, ".codex"), fs, { platform: "win32" });
    }
    addCodexSessionDirs(dirs, path.win32.join(root, "root", ".codex"), fs, { platform: "win32" });
  }
  return normalizeSourceDirs(dirs, { platform: "win32" });
}

export function defaultWslSessionDirs(options = {}) {
  return discoverWslSessionDirs(options);
}

export function discoverWslSessionDirs({
  platform = process.platform,
  env = process.env,
  fs = nativeFs,
  execFile = execFileSync,
  codexHome = null,
} = {}) {
  if (platform === "win32") {
    return discoverWslFromWindows({ env, fs, execFile });
  }

  const dirs = [];
  addCodexSessionDirs(
    dirs,
    localCodexHome({ platform, env, codexHome }),
    fs,
    { platform },
  );
  return normalizeSourceDirs(dirs, { platform });
}

export function discoverLocalSessionDirs({
  platform = process.platform,
  env = process.env,
  fs = nativeFs,
  codexHome = null,
  includeArchived = false,
} = {}) {
  const dirs = [];
  addCodexSessionDirs(
    dirs,
    localCodexHome({ platform, env, codexHome }),
    fs,
    { includeArchived, platform },
  );
  return normalizeSourceDirs(dirs, { platform });
}

export function configuredSessionDirs({ platform = process.platform, env = process.env } = {}) {
  return normalizeSourceDirs(
    configuredList(env.CODEX_USAGE_SESSIONS, platform === "win32" ? ";" : ":"),
    { platform },
  );
}

export function discoverSourceRegistry({
  platform = process.platform,
  env = process.env,
  fs = nativeFs,
  execFile = execFileSync,
  codexHome = null,
} = {}) {
  const local = discoverLocalSessionDirs({ platform, env, fs, codexHome });
  const localWithArchived = discoverLocalSessionDirs({
    platform,
    env,
    fs,
    codexHome,
    includeArchived: true,
  });
  const wsl = discoverWslSessionDirs({ platform, env, fs, execFile, codexHome });
  const windows = discoverWindowsSessionDirs({ platform, env, fs });
  const configured = configuredSessionDirs({ platform, env });
  const windowsScope = platform === "win32"
    ? normalizeSourceDirs([...localWithArchived, ...windows], { platform })
    : windows;
  const discoveredAll = platform === "win32"
    ? [...wsl, ...localWithArchived, ...windows]
    : [...wsl, ...windows];
  const all = configured.length > 0
    ? configured
    : normalizeSourceDirs(discoveredAll, { platform });
  return { all, local, wsl, windows: windowsScope };
}

export const DEFAULT_WINDOWS_USERS_ROOT = windowsUsersRoot();
export const DEFAULT_WINDOWS_SESSIONS_DIR = pathApi(process.platform).join(
  DEFAULT_WINDOWS_USERS_ROOT,
  windowsUserName(),
  ".codex",
  "sessions",
);
export const DEFAULT_WINDOWS_ARCHIVED_SESSIONS_DIR = pathApi(process.platform).join(
  DEFAULT_WINDOWS_USERS_ROOT,
  windowsUserName(),
  ".codex",
  "archived_sessions",
);
