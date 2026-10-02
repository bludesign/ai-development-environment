import { runScript, type ScriptRunOptions } from "@/services/scripts/runtime";
export type {
  ScriptStoredValue as SseStoredValue,
  ScriptStorage as SseScriptStorage,
  ScriptRunResult as SseScriptRunResult,
} from "@/services/scripts/runtime";
export type SseScriptRunOptions = ScriptRunOptions & {
  storage: NonNullable<ScriptRunOptions["storage"]>;
};
export const runSseScript = (options: SseScriptRunOptions) =>
  runScript({ ...options, mode: "sse" });
