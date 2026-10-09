import { createApp } from "./app";
import { readConfig } from "./config";
import { getPool } from "./db/pool";
import { resolveAiSettings } from "./modules/ai-settings";
import { runWorkerOnce } from "./modules/ai-worker";

const config = readConfig();
const ai = resolveAiSettings(config);
const app = createApp({ ai });

app.listen(config.port, "127.0.0.1", () => {
  console.log(`Bop API listening on http://127.0.0.1:${config.port}`);
});

if (config.aiWorker) {
  const pool = getPool();
  if (pool) {
    setInterval(() => {
      void runWorkerOnce(pool, ai).catch(() => {
        console.log(JSON.stringify({ scope: "ai", kind: "worker_error" }));
      });
    }, 1000);
  }
}
