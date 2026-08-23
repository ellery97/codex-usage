export const DEFAULT_PORT = 8787;
export const DEFAULT_FALLBACK_PORTS = Object.freeze([9787, 3000, 5000, 0]);

const RETRYABLE_PORT_ERRORS = new Set(["EACCES", "EADDRINUSE"]);

function portError(value, source) {
  const label = source ? ` for ${source}` : "";
  return new Error(
    `Invalid port${label}: ${value}. Expected an integer from 0 to 65535.`,
  );
}

export function parsePort(value, source = "") {
  let port;
  if (typeof value === "number") {
    port = value;
  } else {
    const text = String(value ?? "").trim();
    if (!/^\d+$/.test(text)) throw portError(value, source);
    port = Number(text);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw portError(value, source);
  }
  return port;
}

export function parsePortArgv(argv = []) {
  let parsed = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (argument === "--port" || argument === "-p") {
      if (index + 1 >= argv.length) {
        throw new Error(`Missing value for ${argument}`);
      }
      index += 1;
      parsed = { port: parsePort(argv[index], argument), explicit: true, source: "cli" };
      continue;
    }
    if (argument.startsWith("--port=")) {
      parsed = {
        port: parsePort(argument.slice("--port=".length), "--port"),
        explicit: true,
        source: "cli",
      };
      continue;
    }
    if (argument.startsWith("-p=")) {
      parsed = {
        port: parsePort(argument.slice("-p=".length), "-p"),
        explicit: true,
        source: "cli",
      };
    }
  }
  return parsed;
}

export function resolvePortConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const cli = parsePortArgv(argv);
  if (cli) return cli;

  for (const name of ["PORT", "CODEX_USAGE_PORT"]) {
    const value = env?.[name];
    if (value == null || String(value).trim() === "") continue;
    return { port: parsePort(value, name), explicit: true, source: name };
  }

  return { port: DEFAULT_PORT, explicit: false, source: "default" };
}

export function portCandidates({ port, explicit = false } = {}) {
  const normalized = parsePort(port, "port");
  if (explicit) return [normalized];
  return [...new Set([normalized, ...DEFAULT_FALLBACK_PORTS])];
}

export function isRetryablePortError(error) {
  return RETRYABLE_PORT_ERRORS.has(error?.code);
}

export function listenOnServer(server, port, host) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const onListening = () => {
      const address = server.address?.();
      const actualPort = address && typeof address === "object" ? address.port : port;
      finish(resolve, actualPort);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function closeListeningServer(server) {
  if (!server?.listening || typeof server.close !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      server.off?.("error", finish);
      resolve();
    };
    server.once?.("error", finish);
    try {
      server.close(finish);
    } catch {
      finish();
    }
  });
}

function annotatePortError(error, attempts) {
  if (!error || typeof error !== "object") return error;
  error.attemptedPorts = attempts.map(({ port, code }) => ({ port, code: code || null }));
  const attempted = attempts.map(({ port }) => port).join(", ");
  if (attempted && !String(error.message).includes("attempted ports")) {
    error.message = `${error.message} (attempted ports: ${attempted})`;
  }
  return error;
}

export async function listenWithFallback({
  createServer,
  host,
  port,
  explicit = false,
  setupServer = () => {},
  listenServer = listenOnServer,
  closeServer = closeListeningServer,
} = {}) {
  if (typeof createServer !== "function") {
    throw new TypeError("listenWithFallback requires a createServer function");
  }

  const candidates = portCandidates({ port, explicit });
  const attempts = [];
  let lastError = null;

  for (const candidate of candidates) {
    let server = null;
    try {
      server = createServer(candidate);
      setupServer(server, candidate);
      const actualPort = await listenServer(server, candidate, host);
      return {
        server,
        port: Number.isInteger(actualPort) ? actualPort : candidate,
        requestedPort: candidate,
        attempts,
      };
    } catch (error) {
      lastError = error;
      attempts.push({ port: candidate, code: error?.code });
      await closeServer(server);
      if (explicit || !isRetryablePortError(error)) {
        throw annotatePortError(error, attempts);
      }
    }
  }

  throw annotatePortError(lastError || new Error("No port candidates available"), attempts);
}
