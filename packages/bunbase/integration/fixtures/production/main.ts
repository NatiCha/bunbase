import { createBunBaseClient } from "../../../src/client.ts";
import * as schema from "./schema.ts";

function show(id: string, value: string) {
  document.getElementById(id)!.textContent = value;
}
const client = createBunBaseClient({
  url: location.origin,
  schema,
  serverFields: { tasks: ["id"] },
});
let recordId = "";
function action(id: string, event: string, run: () => Promise<void>) {
  document.getElementById(id)!.addEventListener(event, (e) => {
    e.preventDefault();
    void run().catch((error: Error) => show("error", error.message));
  });
}
action("login", "submit", async () => {
  const form = new FormData(document.getElementById("login") as HTMLFormElement);
  await client.auth.login({
    email: String(form.get("email")),
    password: String(form.get("password")),
  });
  show("auth", "Signed in");
});
action("subscribe", "click", async () => {
  const url = new URL("/realtime", location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
    // Messages are serialized: presence state confirms the preceding table subscription.
    socket.send(JSON.stringify({ type: "subscribe:presence", channel: "smoke-ready" }));
  };
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(String(data));
    if (event.type === "presence:state") show("connection", "ready");
    if (event.action) show("event", `${event.action}:${event.id}`);
    if (event.type === "error") show("error", event.message);
  };
});
action("create", "click", async () => {
  const record = await client.api.tasks.create({ title: "Production browser task" });
  recordId = record.id;
  show("record", recordId);
});
action("upload", "click", async () => {
  const file = (document.getElementById("file") as HTMLInputElement).files?.[0];
  if (!file || !recordId) throw new Error("Create a task and select a file first");
  const result = await client.files.upload("tasks", recordId, file);
  show("uploaded", result.file.id);
});
