// One simulated host: HUB_DATA=<dir> (noop.toml next to it). Pulls, waits for the start time, then claims the task.
import { claim, P, pull } from "../../src/core";
const [id, startAt] = [process.argv[2], Number(process.argv[3])];
if (!(await pull())) { console.log(JSON.stringify({ host: process.env.HUB_HOST, err: "pull" })); process.exit(1); }
await Bun.sleep(Math.max(0, startAt - Date.now()));
const won = await claim(P("tasks", "inbox", `${id}.md`), process.env.HUB_HOST!);
console.log(JSON.stringify({ host: process.env.HUB_HOST, won: !!won }));
