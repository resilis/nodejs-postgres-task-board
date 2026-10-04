# Node.js task board with PostgreSQL

A small, editable task board built with Node.js and browser-native HTML, CSS, and JavaScript. PostgreSQL stores tasks across app restarts.

**Sample version:** 1.0.0  
**Source:** [resilis/nodejs-postgres-task-board](https://github.com/resilis/nodejs-postgres-task-board)  
**Fork this sample:** [Create a GitHub fork](https://github.com/resilis/nodejs-postgres-task-board/fork)

## What it does

- Create, rename, move, and delete tasks in To do, Doing, and Done.
- Keep at most 100 tasks. Task titles contain 1–120 trimmed characters.
- Start with three sample tasks for a useful first launch.
- Save tasks in PostgreSQL. Deleting a seeded task does not cause it to return after an app restart.
- Set DEMO_READ_ONLY=true to make a shared demo view-only. The server rejects every non-read HTTP method on every path, and the interface disables its write controls. It defaults to false for your own deployment.
- Report database readiness at /ready.

This sample has no sign-in. Use a fresh, dedicated sample database. Do not point it at a production database or a database shared with other applications.

## Run locally

Use Node.js 22.15 or newer and Docker. Copy .env.example to .env. Replace both password placeholders with the same randomly generated local password. Do not commit .env.

    cp .env.example .env
    npm ci
    docker run --detach --name nodejs-task-board-postgres-local --publish 127.0.0.1:5432:5432 --env-file .env postgres:17-alpine
    npm start

Open http://localhost:3000. The server binds to 0.0.0.0 and uses PORT, which defaults to 3000.

The database container needs POSTGRES_USER, POSTGRES_PASSWORD, and POSTGRES_DB from .env. The app needs DATABASE_URL. Set DATABASE_URL to a PostgreSQL connection string for this local database. Keep the password private. Stop the local database container with:

    docker stop nodejs-task-board-postgres-local

Run the HTTP, PostgreSQL persistence, restart, fail-closed, and concurrent task-limit checks with:

    npm test

The integration test creates a uniquely named disposable PostgreSQL 17 Docker container with a random local password. It stops and removes that exact container and its temporary environment file after the test.

## Run with Docker

Build the app image from the repository root:

    docker build -t resilis-nodejs-postgres-task-board .

Run a fresh PostgreSQL container and the app on a Docker network you own, or connect the app container to a local database through the host gateway. Set DATABASE_URL for the app container to use the database hostname reachable from that container. For example:

    docker run --rm --name resilis-nodejs-postgres-task-board --add-host=host.docker.internal:host-gateway --publish 3000:3000 --env PORT=3000 --env DEMO_READ_ONLY=false --env DATABASE_URL=postgresql://taskboard:replace-with-your-random-password@host.docker.internal:5432/taskboard resilis-nodejs-postgres-task-board

Replace the password placeholder with the same private value configured for your local PostgreSQL container. Open http://localhost:3000. The container runs as the unprivileged node user.

## Deploy on Resilis

Use your own fork as the source for a new app. Connect the repository and deploy its main branch with the Node build option or build from its Dockerfile. Attach a fresh, dedicated PostgreSQL database and set DATABASE_URL using the connection value supplied by your workspace. Keep the connection value private. Check database network and TLS requirements for your environment, then verify that /ready responds with a ready status.

Your deployment stays editable by default. Set DEMO_READ_ONLY=true only for a shared, view-only demo and after checking the board's CRUD and restart persistence. Verify the current Resilis setup flow in your workspace before relying on a specific setting or screen.

## Database ownership

On startup, this app additively creates two tables in the connected sample database:

- sample_task_board_tasks stores task IDs, titles, statuses, and timestamps.
- sample_task_board_metadata stores a one-time sample-seed marker.

The app does not drop, truncate, or rename tables. The marker prevents a task deleted by a user from being seeded again after an app restart. Task creation uses a PostgreSQL advisory transaction lock and a count check so concurrent requests cannot exceed 100 tasks.

If DATABASE_URL is missing, unreachable, or invalid, the app exits before it listens. It never switches to in-memory storage. Startup and API errors do not include connection values.

## API

- GET /api/tasks lists tasks.
- POST /api/tasks creates a task from {"title":"..."}.
- PATCH /api/tasks/:id changes title, status, or both.
- DELETE /api/tasks/:id deletes a task.
- GET /api/config reports read-only mode, storage, and task limit.
- GET /ready checks PostgreSQL and reports app readiness.

Write requests use JSON. Invalid titles or statuses return 400; an unknown task returns 404; a full board returns 409; a body above 4 KB returns 413.

## Project files

- src/server.js serves the UI and validates the HTTP API.
- src/postgres-store.js owns additive schema setup and parameterized task queries.
- public/ contains the same task-board interface as the in-memory sample.
- tests/postgres.integration.test.js exercises HTTP flows against a disposable PostgreSQL database.

## License

MIT. See LICENSE.
