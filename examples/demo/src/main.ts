import "./style.css";
import { formatRelativeTime } from "./relative-time.auto";
import { TodoStore } from "./todo-store.auto";
import type { Todo } from "./types";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const store = new TodoStore([
  { id: "1", title: "Describe a module in plain English", done: true, createdAt: minutesAgo(60 * 26) },
  { id: "2", title: "Import it from TypeScript", done: true, createdAt: minutesAgo(90) },
  { id: "3", title: "Let tsc and Vite agree on the code", done: false, createdAt: minutesAgo(3) },
]);

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
  <h1>Todos <small>powered by .auto files</small></h1>
  <form id="new-todo">
    <input name="title" placeholder="What needs to be done?" autocomplete="off" />
    <button>Add</button>
  </form>
  <p class="error" hidden></p>
  <ul id="list"></ul>
  <footer>
    <span id="remaining"></span>
    <button id="clear">Clear completed</button>
  </footer>
`;

const form = app.querySelector<HTMLFormElement>("#new-todo")!;
const error = app.querySelector<HTMLParagraphElement>(".error")!;
const list = app.querySelector<HTMLUListElement>("#list")!;
const remaining = app.querySelector<HTMLSpanElement>("#remaining")!;

function renderItem(todo: Todo): HTMLLIElement {
  const item = document.createElement("li");
  item.className = todo.done ? "done" : "";
  const checkbox = Object.assign(document.createElement("input"), { type: "checkbox", checked: todo.done });
  checkbox.addEventListener("change", () => store.toggle(todo.id));
  const title = Object.assign(document.createElement("span"), { className: "title", textContent: todo.title });
  const time = Object.assign(document.createElement("time"), {
    dateTime: todo.createdAt.toISOString(),
    textContent: formatRelativeTime(todo.createdAt),
  });
  const remove = Object.assign(document.createElement("button"), { className: "remove", textContent: "×", title: "Remove" });
  remove.addEventListener("click", () => store.remove(todo.id));
  item.append(checkbox, title, time, remove);
  return item;
}

function render(todos: readonly Todo[]): void {
  list.replaceChildren(...todos.map(renderItem));
  remaining.textContent = `${store.remaining} of ${todos.length} left`;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = form.elements.namedItem("title") as HTMLInputElement;
  try {
    store.add(input.value);
    input.value = "";
    error.hidden = true;
  } catch (e) {
    error.textContent = e instanceof RangeError ? "Please enter a title." : String(e);
    error.hidden = false;
  }
});
app.querySelector("#clear")!.addEventListener("click", () => store.clearCompleted());

store.subscribe(render);
render(store.todos);
setInterval(() => render(store.todos), 30_000);
