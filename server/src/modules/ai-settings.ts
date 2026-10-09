import type { AppConfig } from "../config";
import { createTestProvider } from "./ai-test-provider";
import type { AiProvider } from "./ai-provider";
import type { WorkerSettings } from "./ai-worker";

export type AiSettings = WorkerSettings & {
  testEnabled: boolean;
  maxAttempts: number;
  maxTasksPerMinute: number;
};

export function resolveAiSettings(
  config: AppConfig,
  override: Partial<AiSettings> & { testProvider?: boolean; providers?: AiProvider[] } = {},
): AiSettings {
  const testEnabled = override.testProvider ?? override.testEnabled ?? config.aiTestProvider;
  const providers = override.providers ?? (testEnabled ? [createTestProvider()] : []);
  return {
    providers,
    testEnabled,
    maxAttempts: override.maxAttempts ?? config.aiMaxAttempts,
    timeoutMs: override.timeoutMs ?? config.aiTimeoutMs,
    backoffMs: override.backoffMs ?? config.aiBackoffMs,
    staleRunningMs: override.staleRunningMs ?? config.aiStaleRunningMs,
    maxTasksPerMinute: override.maxTasksPerMinute ?? config.aiMaxTasksPerMinute,
    workerId: override.workerId,
  };
}
