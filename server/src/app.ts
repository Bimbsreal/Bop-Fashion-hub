import express, { type NextFunction, type Request, type Response } from "express";
import { readConfig } from "./config";
import { DomainError } from "./errors";
import { getPool } from "./db/pool";
import { attachUser } from "./http/actor";
import { authRouter } from "./routes/auth";
import { resolveAiSettings, type AiSettings } from "./modules/ai-settings";
import { catalogRouter } from "./routes/catalog";
import { designRouter } from "./routes/design";
import { aiRouter } from "./routes/ai";
import { analysesRouter } from "./routes/analyses";
import { visualizationsRouter } from "./routes/visualizations";
import { tryOnRouter } from "./routes/try-on";
import { measurementsRouter } from "./routes/measurements";
import { fitRouter } from "./routes/fit";
import { styleRouter } from "./routes/style";
import { commerceRouter } from "./routes/commerce";
import { ordersRouter } from "./routes/orders";
import { paymentsRouter } from "./routes/payments";
import { mediaRouter } from "./routes/media";
import { developmentAdapter, simulationAllowed, type PaymentAdapter } from "./modules/payment-adapter";
import { localMediaStorage, type MediaStorage } from "./modules/storage";

export type AppOptions = {
  storage?: MediaStorage;
  maxMediaBytes?: number;
  maxMediaEdge?: number;
  maxUploadsPerMinute?: number;
  ai?: AiSettings;
  nodeEnv?: string;
  paymentSimulation?: boolean;
  paymentAdapter?: PaymentAdapter;
  maxPaymentsPerMinute?: number;
};

export function createApp(options: AppOptions = {}) {
  const config = readConfig();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(attachUser);

  app.get("/api/v1/health", async (_request, response) => {
    const pool = getPool();
    if (!pool) {
      response.status(503).json({ ok: false, database: "unconfigured" });
      return;
    }
    try {
      await pool.query("SELECT 1");
      response.json({ ok: true, database: "ok" });
    } catch {
      response.status(503).json({ ok: false, database: "unavailable" });
    }
  });

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/catalog", catalogRouter);
  app.use("/api/v1/design-projects", designRouter);
  const ai = options.ai ?? resolveAiSettings(config);
  app.use("/api/v1/ai", aiRouter(ai));
  app.use("/api/v1/analyses", analysesRouter(ai));
  app.use("/api/v1/visualizations", visualizationsRouter);
  app.use("/api/v1/try-on", tryOnRouter());
  app.use("/api/v1/measurements", measurementsRouter());
  app.use("/api/v1/fit", fitRouter());
  app.use("/api/v1/style", styleRouter());
  app.use("/api/v1/commerce", commerceRouter());
  app.use("/api/v1/orders", ordersRouter(options.storage ?? localMediaStorage(config.mediaDir)));
  const nodeEnv = options.nodeEnv ?? config.nodeEnv;
  const simulationRequested = options.paymentSimulation ?? config.paymentSimulation;
  app.use(
    "/api/v1/payments",
    paymentsRouter({
      adapter: options.paymentAdapter ?? developmentAdapter(),
      simulationEnabled: simulationAllowed(nodeEnv, simulationRequested),
      maxPerMinute: options.maxPaymentsPerMinute ?? 20,
    }),
  );
  app.use(
    "/api/v1/media",
    mediaRouter({
      storage: options.storage ?? localMediaStorage(config.mediaDir),
      limits: {
        maxBytes: options.maxMediaBytes ?? config.maxMediaBytes,
        maxEdge: options.maxMediaEdge ?? config.maxMediaEdge,
      },
      maxUploadsPerMinute: options.maxUploadsPerMinute ?? 30,
    }),
  );

  app.use((_request: Request, response: Response) => {
    response.status(404).json({ error: { code: "not_found", message: "Not found." } });
  });

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (isTooLarge(error) || (error instanceof DomainError && error.code === "file_too_large")) {
      response.status(413).json({ error: { code: "file_too_large", message: "File is too large." } });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: { code: "invalid_body", message: "Request body must be JSON." } });
      return;
    }
    if (error instanceof DomainError) {
      const status =
        error.code === "forbidden"
          ? 403
          : error.code === "unauthenticated"
            ? 401
            : error.code === "not_found"
              ? 404
              :         error.code === "rate_limited"
                ? 429
                : error.code === "conflict" || error.code === "cancel_unsupported"
                  ? 409
                  : error.code === "provider_timeout" || error.code === "provider_unavailable"
                    ? 503
                    : 400;
      response.status(status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    response.status(500).json({ error: { code: "internal", message: "Something went wrong." } });
  });

  return app;
}

function isTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { type?: string; status?: number };
  return record.type === "entity.too.large" || record.status === 413;
}
