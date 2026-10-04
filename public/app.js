const statuses = ["todo", "doing", "done"];
const labels = { todo: "To do", doing: "Doing", done: "Done" };
const form = document.querySelector("#create-form");
const titleInput = document.querySelector("#new-title");
const notice = document.querySelector("#notice");
const storageLabel = document.querySelector("#storage-label");
const writeMode = document.querySelector("#write-mode");
const taskCount = document.querySelector("#task-count");
let readOnly = true;
let tasks = [];

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
}

function clearNotice() {
  notice.textContent = "";
  notice.hidden = true;
}

function setControlsDisabled(disabled) {
  titleInput.disabled = disabled;
  form.querySelector("button[type=submit]").disabled = disabled;
  document.querySelectorAll(".task-card button, .task-card select").forEach((control) => {
    control.disabled = disabled;
  });
}

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options && options.headers) }
  });
  if (response.status === 204) {
    return null;
  }
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error && body.error.message ? body.error.message : "The request could not be completed.");
  }
  return body;
}

function button(label, className, action) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = className;
  control.textContent = label;
  control.disabled = readOnly;
  control.addEventListener("click", action);
  return control;
}

function updateTask(id, changes) {
  return request("/api/tasks/" + encodeURIComponent(id), {
    method: "PATCH",
    body: JSON.stringify(changes)
  }).then(refresh);
}

function renderEditForm(task) {
  const editForm = document.createElement("form");
  editForm.className = "edit-form";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 120;
  input.value = task.title;
  input.setAttribute("aria-label", "Edit task title");
  input.required = true;
  const actions = document.createElement("div");
  actions.className = "edit-actions";
  const cancel = button("Cancel", "button button-quiet", () => renderTasks());
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "button button-primary";
  save.textContent = "Save";
  save.disabled = readOnly;
  actions.append(cancel, save);
  editForm.append(input, actions);
  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearNotice();
    try {
      await updateTask(task.id, { title: input.value });
    } catch (error) {
      showNotice(error.message);
    }
  });
  return editForm;
}

function renderTask(task) {
  const card = document.createElement("article");
  card.className = "task-card";
  card.dataset.status = task.status;
  const top = document.createElement("div");
  top.className = "task-topline";
  const title = document.createElement("p");
  title.className = "task-title";
  title.textContent = task.title;
  const number = document.createElement("span");
  number.className = "task-number";
  number.textContent = task.id.slice(0, 8).toUpperCase();
  top.append(title, number);

  const controls = document.createElement("div");
  controls.className = "task-controls";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Move " + task.title + " to another status");
  select.disabled = readOnly;
  for (const status of statuses) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = labels[status];
    option.selected = task.status === status;
    select.append(option);
  }
  select.addEventListener("change", async () => {
    clearNotice();
    try {
      await updateTask(task.id, { status: select.value });
    } catch (error) {
      showNotice(error.message);
      renderTasks();
    }
  });
  const actions = document.createElement("div");
  actions.className = "task-actions";
  actions.append(
    button("Edit", "button button-quiet", () => {
      card.replaceChildren(renderEditForm(task));
      card.dataset.status = task.status;
    }),
    button("Delete", "button button-quiet button-danger", async () => {
      clearNotice();
      try {
        await request("/api/tasks/" + encodeURIComponent(task.id), { method: "DELETE" });
        await refresh();
      } catch (error) {
        showNotice(error.message);
      }
    })
  );
  controls.append(select, actions);
  card.append(top, controls);
  return card;
}

function renderTasks() {
  for (const status of statuses) {
    const lane = document.querySelector('[data-tasks="' + status + '"]');
    const empty = document.querySelector('[data-empty="' + status + '"]');
    const grouped = tasks.filter((task) => task.status === status);
    lane.replaceChildren(...grouped.map(renderTask));
    empty.classList.toggle("is-visible", grouped.length === 0);
    document.querySelector('[data-count="' + status + '"]').textContent = String(grouped.length);
  }
  taskCount.textContent = String(tasks.length);
  setControlsDisabled(readOnly);
}

async function refresh() {
  tasks = await request("/api/tasks");
  renderTasks();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (readOnly) {
    return;
  }
  clearNotice();
  try {
    await request("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: titleInput.value })
    });
    titleInput.value = "";
    await refresh();
    titleInput.focus();
  } catch (error) {
    showNotice(error.message);
  }
});

async function initialize() {
  try {
    const config = await request("/api/config");
    readOnly = config.readOnly;
    storageLabel.textContent = config.storage === "postgres" ? "POSTGRESQL STORAGE" : "IN-MEMORY SAMPLE";
    writeMode.textContent = readOnly
      ? "Shared demo · viewing only"
      : config.storage === "postgres" ? "Editable sample · saved in PostgreSQL" : "Editable sample · resets on restart";
    setControlsDisabled(readOnly);
    await refresh();
  } catch {
    readOnly = true;
    storageLabel.textContent = "BOARD UNAVAILABLE";
    writeMode.textContent = "Controls are disabled until the board is ready.";
    setControlsDisabled(true);
    showNotice("The board could not load. Check the server and try again.");
  }
}

initialize();
