import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEEDED_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003"
];

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore"
  });
  if (result.error) {
    throw new Error("Docker is required for PostgreSQL integration tests.");
  }
  if (result.status !== 0) {
    throw new Error("A dedicated disposable PostgreSQL test container could not be started or checked.");
  }
  return options.capture ? result.stdout.trim() : "";
}

async function startDisposableDatabase() {
  runDocker(["info"]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "resilis-task-board-pg-test-"));
  const envFile = path.join(directory, "postgres.env");
  const password = randomBytes(24).toString("hex");
  const name = "resilis-task-board-pg-" + process.pid + "-" + randomUUID().slice(0, 8);
  let started = false;
  try {
    await writeFile(
      envFile,
      "POSTGRES_USER=taskboard\nPOSTGRES_PASSWORD=" + password + "\nPOSTGRES_DB=taskboard\n",
      { mode: 0o600 }
    );
    runDocker([
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--publish",
      "127.0.0.1::5432",
      "--env-file",
      envFile,
      "postgres:17-alpine"
    ]);
    started = true;
    const mapping = runDocker(["port", name, "5432/tcp"], { capture: true });
    const match = mapping.match(/:(\d+)\s*$/);
    if (!match) {
      throw new Error("The dedicated PostgreSQL test port could not be read.");
    }
    const port = Number(match[1]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = spawnSync("docker", ["exec", name, "pg_isready", "-U", "taskboard", "-d", "taskboard"], {
        stdio: "ignore"
      });
      if (result.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) {
      throw new Error("The dedicated PostgreSQL test database did not become ready.");
    }
    return {
      name,
      directory,
      url: "postgresql://taskboard:" + password + "@127.0.0.1:" + port + "/taskboard",
      async stop() {
        if (started) {
          try {
            runDocker(["stop", name]);
          } catch {}
          started = false;
        }
        await rm(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    if (started) {
      try {
        runDocker(["stop", name]);
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function makeEnvironment(extraEnv) {
  const environment = { ...process.env, PORT: "0", DEMO_READ_ONLY: "false" };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === null) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

async function launchServer(extraEnv) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: makeEnvironment(extraEnv),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errorOutput += chunk;
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PostgreSQL-backed app did not start within 12 seconds.")), 12000);
    const inspect = () => {
      const match = output.match(/0\.0\.0\.0:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("PostgreSQL-backed app exited before listening with code " + code + ". " + errorOutput));
    });
    inspect();
  });
  let stopped = false;
  return {
    child,
    baseUrl: "http://127.0.0.1:" + port,
    async stop() {
      if (stopped || child.exitCode !== null) {
        stopped = true;
        return;
      }
      stopped = true;
      const exited = once(child, "exit");
      let timer;
      child.kill("SIGTERM");
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("PostgreSQL-backed app did not stop within 5 seconds.")), 5000);
            timer.unref();
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

async function jsonRequest(baseUrl, pathname, method, body) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const content = response.status === 204 ? null : await response.json();
  return { response, content };
}

async function expectStartupFailure(databaseUrl) {
  const environment = makeEnvironment({ DATABASE_URL: databaseUrl });
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  let timer;
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("App did not fail closed without PostgreSQL.")), 8000);
      timer.unref();
    })
  ]).finally(() => clearTimeout(timer));
  assert.equal(code, 1);
  assert.match(output, /Task board could not start/);
  assert.doesNotMatch(output, /postgresql:\/\//i);
}

test("PostgreSQL API persists across app restarts, enforces limits, and fails closed", { timeout: 120000 }, async (t) => {
  await expectStartupFailure(null);
  await expectStartupFailure("postgresql://taskboard@127.0.0.1:1/taskboard");

  const database = await startDisposableDatabase();
  t.after(() => database.stop());

  let app = await launchServer({ DATABASE_URL: database.url });
  t.after(() => app.stop());

  const ready = await fetch(app.baseUrl + "/ready");
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready", storage: "postgres" });

  const config = await (await fetch(app.baseUrl + "/api/config")).json();
  assert.deepEqual(config, { readOnly: false, maxTasks: 100, storage: "postgres" });

  const initial = await (await fetch(app.baseUrl + "/api/tasks")).json();
  assert.deepEqual(initial.map((task) => task.id), SEEDED_IDS);

  const created = await jsonRequest(app.baseUrl, "/api/tasks", "POST", { title: "Persist this task" });
  assert.equal(created.response.status, 201);
  const updated = await jsonRequest(app.baseUrl, "/api/tasks/" + created.content.id, "PATCH", {
    title: "Persisted task",
    status: "doing"
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.content.title, "Persisted task");
  assert.equal(updated.content.status, "doing");

  const deleted = await jsonRequest(app.baseUrl, "/api/tasks/" + SEEDED_IDS[2], "DELETE");
  assert.equal(deleted.response.status, 204);

  let tasks = await (await fetch(app.baseUrl + "/api/tasks")).json();
  while (tasks.length < 99) {
    const result = await jsonRequest(app.baseUrl, "/api/tasks", "POST", { title: "Capacity task " + tasks.length });
    assert.equal(result.response.status, 201);
    tasks.push(result.content);
  }
  const concurrent = await Promise.all([
    jsonRequest(app.baseUrl, "/api/tasks", "POST", { title: "Concurrent task A" }),
    jsonRequest(app.baseUrl, "/api/tasks", "POST", { title: "Concurrent task B" })
  ]);
  assert.deepEqual(concurrent.map((result) => result.response.status).sort(), [201, 409]);
  tasks = await (await fetch(app.baseUrl + "/api/tasks")).json();
  assert.equal(tasks.length, 100);
  const acceptedConcurrent = concurrent.find((result) => result.response.status === 201);
  const persistedId = created.content.id;

  await app.stop();
  app = await launchServer({ DATABASE_URL: database.url });
  t.after(() => app.stop());
  tasks = await (await fetch(app.baseUrl + "/api/tasks")).json();
  assert.equal(tasks.length, 100);
  assert.equal(tasks.some((task) => task.id === persistedId && task.title === "Persisted task" && task.status === "doing"), true);
  assert.equal(tasks.some((task) => task.id === acceptedConcurrent.content.id), true);
  assert.equal(tasks.some((task) => task.id === SEEDED_IDS[2]), false);

  await app.stop();
  app = await launchServer({ DATABASE_URL: database.url, DEMO_READ_ONLY: "true" });
  t.after(() => app.stop());
  const readonlyConfig = await (await fetch(app.baseUrl + "/api/config")).json();
  assert.equal(readonlyConfig.readOnly, true);
  for (const [method, pathname, body] of [
    ["POST", "/api/tasks", { title: "No write" }],
    ["PATCH", "/api/tasks/" + SEEDED_IDS[0], { status: "done" }],
    ["DELETE", "/api/tasks/" + SEEDED_IDS[0]],
    ["PUT", "/unmapped/write/path", { value: true }]
  ]) {
    const result = await jsonRequest(app.baseUrl, pathname, method, body);
    assert.equal(result.response.status, 403);
    assert.equal(result.content.error.code, "demo_read_only");
  }
  assert.equal((await (await fetch(app.baseUrl + "/api/tasks")).json()).length, 100);
});
