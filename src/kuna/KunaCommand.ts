import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  OwnedProviderProcessSpawnOptions,
  ProviderProcessSnapshot,
  SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  kunaChildEnvironment,
  type KunaInstallation,
} from "./KunaInstallation.js";
import { KUNA_PROVIDER_ID } from "./KunaRelease.js";

/**
 * `kuna functions --json` costs ~210 bytes per function; this admits about
 * 600,000 functions, above the 392,814 of the largest image Kuna documents.
 */
export const KUNA_INVENTORY_OUTPUT_BYTES = 128 * 1024 * 1024;

/** Test seam for the owned process launcher; production uses the default. */
export type KunaProcessLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** One bounded Kuna run inside a private workspace. */
export interface KunaCommandRequest {
  readonly installation: KunaInstallation;
  readonly arguments: readonly string[];
  /** Private directory used as the working and temporary directory. */
  readonly workspace: string;
  /** Operation named by every failure this run reports. */
  readonly operation: string;
  readonly timeoutMs: number;
  /** The deadline callers configured, reported when the run times out. */
  readonly reportedTimeoutMs: number;
  readonly outputBytes: number;
  readonly signal: AbortSignal;
  readonly launcher?: KunaProcessLauncher | undefined;
}

/**
 * How a Kuna run ended. `retained` means the process tree could not be proven
 * stopped, so it may still write into the workspace, which therefore stays
 * with the caller's cleanup owner.
 */
export type KunaCommandOutcome =
  | { readonly kind: "ok"; readonly snapshot: ProviderProcessSnapshot }
  | { readonly kind: "failed"; readonly error: AnalysisError }
  | { readonly kind: "retained"; readonly error: ProviderCleanupError };

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Run Kuna under an owned process group with REA's environment and limits. */
export const runKunaCommand = async (
  request: KunaCommandRequest,
): Promise<KunaCommandOutcome> => {
  const { installation } = request;
  try {
    const snapshot = await runOwnedCommand(
      {
        command: installation.executable,
        arguments: request.arguments,
        runId: `rea-kuna-${randomUUID()}`,
        // A script's process reports its interpreter, not the configured path.
        ...(installation.script ? { expectedCommand: null } : {}),
        cwd: request.workspace,
        hostEnvironment: kunaChildEnvironment(installation.configuration),
        env: { TMPDIR: request.workspace },
      },
      {
        timeoutMs: Math.max(1, request.timeoutMs),
        diagnosticBytes: request.outputBytes,
      },
      {
        signal: request.signal,
        ...(request.launcher === undefined
          ? {}
          : { launcher: request.launcher }),
      },
    );
    return { kind: "ok", snapshot };
  } catch (cause: unknown) {
    return commandFailure(cause, request);
  }
};

/** Copy a file and return the SHA-256 of exactly the bytes copied. */
export const copyAndHash = async (
  source: string,
  destination: string,
  signal: AbortSignal,
): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(source),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  return hash.digest("hex");
};

/** Map an owned-command failure to its typed error, keeping unproven cleanup owned. */
const commandFailure = (
  cause: unknown,
  request: KunaCommandRequest,
): KunaCommandOutcome => {
  const { operation } = request;
  const subcommand = request.arguments[0] ?? "";
  if (!(cause instanceof OwnedCommandFailure))
    return {
      kind: "failed",
      error: request.signal.aborted
        ? new AnalysisCancelledError(operation, { cause })
        : new ProviderAdapterError(KUNA_PROVIDER_ID, operation, {
            cause,
            userMessage: `Cannot run ${request.installation.executable}: ${message(cause)}`,
          }),
    };
  const snapshot = cause.snapshot;
  const capturedOutput =
    snapshot === null
      ? undefined
      : {
          // Output can be evidence-sized, not diagnostic-sized; keep only its tail.
          stdout: snapshot.stdout.text.slice(-4096),
          stderr: snapshot.stderr.text,
          truncated:
            snapshot.diagnosticTruncated === true ||
            snapshot.outputIncomplete === true ||
            snapshot.stdout.text.length > 4096,
          exit_code: snapshot.exitCode ?? null,
          signal: snapshot.signal ?? null,
        };
  const details = {
    cause,
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
  };
  if (cause.cleanupFailure !== null)
    return {
      kind: "retained",
      error: new ProviderCleanupError(
        KUNA_PROVIDER_ID,
        [...cause.resources, request.workspace],
        { reason: cause.cleanupFailure },
        { operation, cause },
      ),
    };
  if (cause.reason === "cancelled")
    return {
      kind: "failed",
      error: new AnalysisCancelledError(operation, details),
    };
  if (cause.reason === "timeout")
    return {
      kind: "failed",
      error: new AnalysisTimeoutError(
        operation,
        request.reportedTimeoutMs,
        details,
      ),
    };
  if (cause.reason === "output-limit")
    return {
      kind: "failed",
      error: new AnalysisResourceConstraintError(
        operation,
        "capacity",
        `kuna ${subcommand} wrote more than ${String(request.outputBytes)} bytes of output.`,
        { output_limit_bytes: request.outputBytes },
        details,
      ),
    };
  const exitCode = capturedOutput?.exit_code;
  return {
    kind: "failed",
    error: new ProviderAdapterError(KUNA_PROVIDER_ID, operation, {
      ...details,
      userMessage: `kuna ${subcommand} failed${exitCode === undefined || exitCode === null ? "" : ` with exit code ${String(exitCode)}`}: ${capturedOutput?.stderr.trim().split("\n").at(-1) ?? cause.message}`,
    }),
  };
};
