import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresTaskStore, TaskLimitError } from "./postgres-store.js";

const MAX_BODY_BYTES = 4096;
const MAX_TITLE_LENGTH = 120;
const MAX_TASKS = 100;
const STATUSES = new Set(["todo", "doing", "done"]);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const READ_ONLY = process.env.DEMO_READ_ONLY === "true";
let STORE;

class HttpProblem extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function sendProblem(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

function applyHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  response.setHeader("X-Frame-Options", "DENY");
}

async function readJson(request) {
  const contentType = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    request.resume();
    throw new HttpProblem(415, "unsupported_media_type", "Send JSON with Content-Type application/json.");
  }
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    request.resume();
    throw new HttpProblem(413, "body_too_large", "Request body must be 4 KB or smaller.");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpProblem(413, "body_too_large", "Request body must be 4 KB or smaller."));
        return;
      }
      if (chunks.length === 0) {
        reject(new HttpProblem(400, "invalid_json", "Request body must contain a JSON object."));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || Array.isArray(body) || typeof body !== "object") {
          throw new Error("JSON object required.");
        }
        resolve(body);
      } catch {
        reject(new HttpProblem(400, "invalid_json", "Request body must contain a valid JSON object."));
      }
    });
    request.on("error", () => reject(new HttpProblem(400, "invalid_request", "Request body could not be read.")));
  });
}

function validateTitle(value) {
  if (typeof value !== "string") {
    throw new HttpProblem(400, "invalid_title", "Title must be text between 1 and 120 characters.");
  }
  const title = value.trim();
  if (title.length < 1 || title.length > MAX_TITLE_LENGTH) {
    throw new HttpProblem(400, "invalid_title", "Title must be text between 1 and 120 characters.");
  }
  return title;
}

function validateStatus(value) {
  if (!STATUSES.has(value)) {
    throw new HttpProblem(400, "invalid_status", "Status must be todo, doing, or done.");
  }
  return value;
}

function validateKeys(body, allowedKeys) {
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new HttpProblem(400, "invalid_fields", "Request contains an unsupported field.");
  }
}

async function serveStatic(request, response, pathname) {
  const assets = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"]
  };
  const asset = assets[pathname];
  if (!asset) {
    return false;
  }
  const body = await readFile(path.join(ROOT, "public", asset[0]));
  response.statusCode = 200;
  response.setHeader("Content-Type", asset[1]);
  response.setHeader("Cache-Control", "no-cache");
  response.end(body);
  return true;
}

async function route(request, response) {
  const url = new URL(request.url, "http://" + (request.headers.host || "localhost"));
  const pathname = url.pathname;

  if (request.method !== "GET" && request.method !== "HEAD") {
    if (READ_ONLY) {
      request.resume();
      sendProblem(response, 403, "demo_read_only", "This shared demo does not accept changes.");
      return;
    }
    if (await handleWrite(request, response, pathname)) {
      return;
    }
    request.resume();
    sendProblem(response, 405, "method_not_allowed", "This method or path is not supported.");
    return;
  }

  if (pathname === "/ready") {
    await STORE.ping();
    sendJson(response, 200, { status: "ready", storage: "postgres" });
    return;
  }
  if (pathname === "/api/config") {
    sendJson(response, 200, { readOnly: READ_ONLY, maxTasks: MAX_TASKS, storage: "postgres" });
    return;
  }
  if (pathname === "/api/tasks") {
    sendJson(response, 200, await STORE.listTasks());
    return;
  }
  if (await serveStatic(request, response, pathname)) {
    return;
  }
  sendProblem(response, 404, "not_found", "The requested resource was not found.");
}

const server = createServer(async (request, response) => {
  applyHeaders(response);
  try {
    await route(request, response);
  } catch (error) {
    if (error instanceof HttpProblem) {
      sendProblem(response, error.status, error.code, error.message);
    } else if (error instanceof TaskLimitError) {
      sendProblem(response, 409, "task_limit_reached", "The board can hold at most 100 tasks.");
    } else {
      sendProblem(response, 503, "storage_unavailable", "Task storage is unavailable. Try again later.");
    }
  }
});

async function handleWrite(request, response, pathname) {
  if (pathname === "/api/tasks" && request.method === "POST") {
    const body = await readJson(request);
    validateKeys(body, new Set(["title", "status"]));
    if (!Object.hasOwn(body, "title")) {
      throw new HttpProblem(400, "invalid_title", "Title must be text between 1 and 120 characters.");
    }
    const task = await STORE.createTask({
      id: randomUUID(),
      title: validateTitle(body.title),
      status: Object.hasOwn(body, "status") ? validateStatus(body.status) : "todo"
    });
    sendJson(response, 201, task);
    return true;
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (taskMatch && request.method === "PATCH") {
    const body = await readJson(request);
    validateKeys(body, new Set(["title", "status"]));
    if (Object.keys(body).length === 0) {
      throw new HttpProblem(400, "empty_update", "Change a title or status.");
    }
    const changes = {};
    if (Object.hasOwn(body, "title")) {
      changes.title = validateTitle(body.title);
    }
    if (Object.hasOwn(body, "status")) {
      changes.status = validateStatus(body.status);
    }
    const task = await STORE.updateTask(taskMatch[1], changes);
    if (!task) {
      throw new HttpProblem(404, "task_not_found", "Task was not found.");
    }
    sendJson(response, 200, task);
    return true;
  }
  if (taskMatch && request.method === "DELETE") {
    const removed = await STORE.deleteTask(taskMatch[1]);
    if (!removed) {
      throw new HttpProblem(404, "task_not_found", "Task was not found.");
    }
    response.statusCode = 204;
    response.end();
    return true;
  }
  return false;
}

function parsePort(value) {
  const port = value === undefined || value === "" ? 3000 : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer from 0 to 65535.");
  }
  return port;
}

async function start() {
  try {
    const port = parsePort(process.env.PORT);
    STORE = await PostgresTaskStore.connect(process.env.DATABASE_URL);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", resolve);
    });
    const address = server.address();
    process.stdout.write("Task board listening on 0.0.0.0:" + address.port + "\n");
  } catch {
    if (STORE) {
      await STORE.close();
    }
    process.stderr.write("Task board could not start. Check PORT, DATABASE_URL, and database availability.\n");
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await STORE.close();
      process.exit(0);
    });
  });
}

await start();
