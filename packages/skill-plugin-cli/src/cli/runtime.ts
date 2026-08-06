import { ResolveInstallContextUseCase } from "../application/ResolveInstallContextUseCase.ts";
import { InstallPluginCliUseCase } from "../application/InstallPluginCliUseCase.ts";
import { DefaultMacAddressResolver } from "../adapters/MacAddressResolver.ts";
import { NpmrcRegistryConfigAdapter } from "../adapters/NpmrcRegistryConfigAdapter.ts";
import { NpmPluginArtifactAdapter } from "../adapters/NpmPluginArtifactAdapter.ts";
import { OpencodeHostAdapter } from "../adapters/OpencodeHostAdapter.ts";
import { OpenClawHostAdapter } from "../adapters/OpenClawHostAdapter.ts";
import { QrCodeAuthAdapter } from "../adapters/QrCodeAuthAdapter.ts";
import { TerminalCliPresenter } from "../adapters/TerminalCliPresenter.ts";
import { NodeProcessRunner } from "../infrastructure/ProcessRunner.ts";
import type { ProcessCommandTrace, ProcessTraceSink } from "../domain/ports.ts";
import type { QrCodeAuth } from "@wecode/skill-qrcode-auth";

export interface CreateInstallCliUseCaseOptions {
  qrcodeAuthRuntime?: QrCodeAuth;
  verbose?: boolean;
}

class InMemoryProcessTraceSink implements ProcessTraceSink {
  private traces: ProcessCommandTrace[] = [];

  push(trace: ProcessCommandTrace) {
    this.traces.push(trace);
  }

  drain() {
    const current = this.traces;
    this.traces = [];
    return current;
  }
}

export function createInstallCliUseCase(options: CreateInstallCliUseCaseOptions = {}) {
  const traceSink = new InMemoryProcessTraceSink();
  const processRunner = new NodeProcessRunner(traceSink);
  const registryConfig = new NpmrcRegistryConfigAdapter();
  const pluginArtifactPort = new NpmPluginArtifactAdapter(processRunner);
  const hostAdapters = {
    opencode: new OpencodeHostAdapter(processRunner, pluginArtifactPort),
    openclaw: new OpenClawHostAdapter(processRunner, pluginArtifactPort),
  } as const;
  const resolveContext = new ResolveInstallContextUseCase(
    registryConfig,
    new DefaultMacAddressResolver(),
    hostAdapters,
  );

  return new InstallPluginCliUseCase(
    resolveContext,
    registryConfig,
    new TerminalCliPresenter(undefined, undefined, options.verbose ?? false),
    new QrCodeAuthAdapter(options.qrcodeAuthRuntime),
    hostAdapters,
    traceSink,
  );
}
