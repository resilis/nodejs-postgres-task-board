import { Pool } from "pg";

const MAX_TASKS = 100;
const LOCK_KEY = "68431102761004";
const TABLE = "sample_task_board_tasks";
const META_TABLE = "sample_task_board_metadata";
const SEEDED_TASKS = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Map the first user journey",
    status: "todo",
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z"
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    title: "Review the deployment checklist",
    status: "doing",
    createdAt: "2026-01-01T09:05:00.000Z",
    updatedAt: "2026-01-01T09:05:00.000Z"
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    title: "Share the sample with your team",
    status: "done",
    createdAt: "2026-01-01T09:10:00.000Z",
    updatedAt: "2026-01-01T09:10:00.000Z"
  }
];

export class TaskLimitError extends Error {}

function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export class PostgresTaskStore {
  static async connect(connectionString) {
    if (!connectionString) {
      throw new Error("DATABASE_URL is required.");
    }
    const pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      max: 5
    });
    const store = new PostgresTaskStore(pool);
    try {
      await store.initialize();
      return store;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  constructor(pool) {
    this.pool = pool;
  }

  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
          "id UUID PRIMARY KEY, " +
          "title VARCHAR(120) NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120), " +
          "status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done')), " +
          "created_at TIMESTAMPTZ NOT NULL DEFAULT now(), " +
          "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
        ")"
      );
      await client.query(
        "CREATE TABLE IF NOT EXISTS " + META_TABLE + " (" +
          "meta_key TEXT PRIMARY KEY, " +
          "created_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
        ")"
      );
      const marker = await client.query(
        "INSERT INTO " + META_TABLE + " (meta_key) VALUES ($1) ON CONFLICT (meta_key) DO NOTHING RETURNING meta_key",
        ["seed-v1"]
      );
      if (marker.rowCount === 1) {
        for (const task of SEEDED_TASKS) {
          await client.query(
            "INSERT INTO " + TABLE + " (id, title, status, created_at, updated_at) " +
              "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
            [task.id, task.title, task.status, task.createdAt, task.updatedAt]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async ping() {
    await this.pool.query("SELECT 1");
  }

  async listTasks() {
    const result = await this.pool.query(
      "SELECT id, title, status, created_at, updated_at FROM " + TABLE + " ORDER BY created_at, id"
    );
    return result.rows.map(toTask);
  }

  async createTask({ id, title, status }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
      const count = await client.query("SELECT COUNT(*)::int AS count FROM " + TABLE);
      if (count.rows[0].count >= MAX_TASKS) {
        throw new TaskLimitError("Task limit reached.");
      }
      const result = await client.query(
        "INSERT INTO " + TABLE + " (id, title, status) VALUES ($1, $2, $3) " +
          "RETURNING id, title, status, created_at, updated_at",
        [id, title, status]
      );
      await client.query("COMMIT");
      return toTask(result.rows[0]);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async updateTask(id, changes) {
    const result = await this.pool.query(
      "UPDATE " + TABLE + " SET title = COALESCE($2, title), status = COALESCE($3, status), updated_at = now() " +
        "WHERE id = $1 RETURNING id, title, status, created_at, updated_at",
      [id, changes.title ?? null, changes.status ?? null]
    );
    return result.rowCount === 0 ? null : toTask(result.rows[0]);
  }

  async deleteTask(id) {
    const result = await this.pool.query("DELETE FROM " + TABLE + " WHERE id = $1", [id]);
    return result.rowCount === 1;
  }

  async close() {
    await this.pool.end();
  }
}
