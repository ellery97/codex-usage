import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  discoverSourceRegistry,
  discoverWindowsSessionDirs,
  discoverWslSessionDirs,
  listWslDistros,
} from "../bin/session-sources.mjs";

function fakeFs({ existing = [], directories = {} } = {}) {
  const existingSet = new Set(existing);
  const directoryMap = new Map(Object.entries(directories));
  return {
    exists(target) {
      return existingSet.has(target);
    },
    directories(root) {
      return directoryMap.get(root) || [];
    },
  };
}

test("discovers native Windows sessions without converting them to a WSL path", () => {
  const root = String.raw`C:\Users`;
  const codexHome = String.raw`C:\Users\Windows11\.codex`;
  const sessions = path.win32.join(codexHome, "sessions");
  const archived = path.win32.join(codexHome, "archived_sessions");
  const dirs = discoverWindowsSessionDirs({
    platform: "win32",
    env: { USERPROFILE: String.raw`C:\Users\Windows11`, USERNAME: "Windows11" },
    fs: fakeFs({
      existing: [sessions, archived],
      directories: { [root]: ["Windows11", "Public"] },
    }),
  });

  assert.deepEqual(dirs, [sessions, archived]);
  assert.equal(dirs.some((dir) => dir.includes("mnt")), false);
});

test("includes a custom Windows Codex home in the Windows and all scopes", () => {
  const windowsRoot = String.raw`C:\Users`;
  const customHome = String.raw`D:\CodexHome`;
  const customSessions = path.win32.join(customHome, "sessions");
  const customArchived = path.win32.join(customHome, "archived_sessions");
  const windowsSessions = String.raw`C:\Users\Windows11\.codex\sessions`;
  const registry = discoverSourceRegistry({
    platform: "win32",
    codexHome: customHome,
    env: {
      USERPROFILE: String.raw`C:\Users\Windows11`,
      USERNAME: "Windows11",
      CODEX_USAGE_WSL_DISTROS: "",
    },
    fs: fakeFs({
      existing: [customSessions, customArchived, windowsSessions],
      directories: { [windowsRoot]: ["Windows11"] },
    }),
    execFile: () => { throw new Error("no wsl"); },
  });

  assert.deepEqual(registry.windows, [customSessions, customArchived, windowsSessions]);
  assert.deepEqual(registry.all, [customSessions, customArchived, windowsSessions]);
});

test("discovers local WSL and mounted Windows directories on POSIX", () => {
  const wslHome = "/home/gejunzhe/.codex";
  const windowsRoot = "/mnt/c/Users";
  const windowsHome = "/mnt/c/Users/Windows11/.codex";
  const fs = fakeFs({
    existing: [
      `${wslHome}/sessions`,
      `${wslHome}/archived_sessions`,
      `${windowsHome}/sessions`,
    ],
    directories: { [windowsRoot]: ["Windows11", "Public"] },
  });

  assert.deepEqual(
    discoverWslSessionDirs({ platform: "linux", codexHome: wslHome, fs }),
    [`${wslHome}/sessions`, `${wslHome}/archived_sessions`],
  );
  assert.deepEqual(
    discoverWindowsSessionDirs({ platform: "linux", fs }),
    [`${windowsHome}/sessions`],
  );
});

test("discovers all accessible WSL users through UNC paths on Windows", () => {
  const distroRoot = String.raw`\\wsl.localhost\Ubuntu-22.04`;
  const homeRoot = path.win32.join(distroRoot, "home");
  const codexHome = path.win32.join(homeRoot, "gejunzhe", ".codex");
  const sessions = path.win32.join(codexHome, "sessions");
  const archived = path.win32.join(codexHome, "archived_sessions");
  const fs = fakeFs({
    existing: [distroRoot, sessions, archived],
    directories: { [homeRoot]: ["gejunzhe"] },
  });

  const dirs = discoverWslSessionDirs({
    platform: "win32",
    env: {},
    fs,
    execFile: () => Buffer.from("Ubuntu-22.04\r\n", "utf16le"),
  });

  assert.deepEqual(dirs, [sessions, archived]);
});

test("merges session and archive directories across multiple WSL distributions", () => {
  const ubuntuRoot = String.raw`\\wsl.localhost\Ubuntu-22.04`;
  const debianRoot = String.raw`\\wsl.localhost\Debian`;
  const ubuntuHome = path.win32.join(ubuntuRoot, "home");
  const debianHome = path.win32.join(debianRoot, "home");
  const ubuntuSessions = path.win32.join(ubuntuHome, "alice", ".codex", "sessions");
  const debianArchived = path.win32.join(debianHome, "bob", ".codex", "archived_sessions");
  const fs = fakeFs({
    existing: [ubuntuRoot, debianRoot, ubuntuSessions, debianArchived],
    directories: {
      [ubuntuHome]: ["alice"],
      [debianHome]: ["bob"],
    },
  });

  assert.deepEqual(
    discoverWslSessionDirs({
      platform: "win32",
      env: {},
      fs,
      execFile: () => Buffer.from("Ubuntu-22.04\r\nDebian\r\n", "utf16le"),
    }),
    [ubuntuSessions, debianArchived],
  );
});

test("merges WSL and native Windows sources in the all scope", () => {
  const windowsRoot = String.raw`C:\Users`;
  const windowsHome = String.raw`C:\Users\Windows11\.codex`;
  const windowsSessions = path.win32.join(windowsHome, "sessions");
  const distroRoot = String.raw`\\wsl.localhost\Ubuntu-22.04`;
  const homeRoot = path.win32.join(distroRoot, "home");
  const wslSessions = path.win32.join(homeRoot, "gejunzhe", ".codex", "sessions");
  const registry = discoverSourceRegistry({
    platform: "win32",
    env: {
      USERPROFILE: String.raw`C:\Users\Windows11`,
      CODEX_USAGE_WSL_DISTROS: "Ubuntu-22.04",
    },
    fs: fakeFs({
      existing: [windowsSessions, distroRoot, wslSessions],
      directories: {
        [windowsRoot]: ["Windows11"],
        [homeRoot]: ["gejunzhe"],
      },
    }),
    execFile: () => { throw new Error("configured distro list should not invoke wsl.exe"); },
  });

  assert.deepEqual(registry.wsl, [wslSessions]);
  assert.deepEqual(registry.windows, [windowsSessions]);
  assert.deepEqual(registry.all, [wslSessions, windowsSessions]);
});

test("falls back to the legacy WSL UNC host and tolerates missing WSL", () => {
  const distroRoot = String.raw`\\wsl$\Ubuntu-22.04`;
  const homeRoot = path.win32.join(distroRoot, "home");
  const sessions = path.win32.join(homeRoot, "gejunzhe", ".codex", "sessions");
  const fs = fakeFs({
    existing: [distroRoot, sessions],
    directories: { [homeRoot]: ["gejunzhe"] },
  });

  assert.deepEqual(
    discoverWslSessionDirs({
      platform: "win32",
      env: {},
      fs,
      execFile: () => Buffer.from("Ubuntu-22.04\r\n", "utf16le"),
    }),
    [sessions],
  );
  assert.deepEqual(
    discoverWslSessionDirs({ platform: "win32", env: {}, fs, execFile: () => { throw new Error("no wsl"); } }),
    [],
  );
});

test("enumerates configured WSL distros and keeps explicit all-source overrides", () => {
  assert.deepEqual(
    listWslDistros({ env: { CODEX_USAGE_WSL_DISTROS: "Ubuntu-22.04; Debian" }, execFile: () => { throw new Error("must not run"); } }),
    ["Ubuntu-22.04", "Debian"],
  );

  const windowsRoot = String.raw`C:\Users`;
  const windowsHome = String.raw`C:\Users\Windows11\.codex`;
  const windowsSessions = path.win32.join(windowsHome, "sessions");
  const explicit = String.raw`D:\Codex\sessions`;
  const registry = discoverSourceRegistry({
    platform: "win32",
    env: {
      USERPROFILE: String.raw`C:\Users\Windows11`,
      CODEX_USAGE_SESSIONS: explicit,
      CODEX_USAGE_WSL_DISTROS: "",
    },
    fs: fakeFs({
      existing: [windowsSessions],
      directories: { [windowsRoot]: ["Windows11"] },
    }),
    execFile: () => { throw new Error("no wsl"); },
  });

  assert.deepEqual(registry.all, [explicit]);
  assert.deepEqual(registry.windows, [windowsSessions]);
  assert.deepEqual(registry.wsl, []);
});
