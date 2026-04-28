import { ResolveInstallContextUseCase } from "../application/ResolveInstallContextUseCase.ts";
import { InstallPluginCliUseCase } from "../application/InstallPluginCliUseCase.ts";
import { DefaultMacAddressResolver } from "../adapters/MacAddressResolver.ts";
import { NpmrcRegistryConfigAdapter } from "../adapters/NpmrcRegistryConfigAdapter.ts";
import { OpencodeHostAdapter } from "../adapters/OpencodeHostAdapter.ts";
import { OpenClawHostAdapter } from "../adapters/OpenClawHostAdapter.ts";
import { QrCodeAuthAdapter } from "../adapters/QrCodeAuthAdapter.ts";
import { TerminalCliPresenter } from "../adapters/TerminalCliPresenter.ts";
import { NodeProcessRunner } from "../infrastructure/ProcessRunner.ts";

export function createInstallCliUseCase() {
  const processRunner = new NodeProcessRunner();
  const registryConfig = new NpmrcRegistryConfigAdapter();
  const hostAdapters = {
    opencode: new OpencodeHostAdapter(processRunner),
    openclaw: new OpenClawHostAdapter(processRunner),
  } as const;
  const resolveContext = new ResolveInstallContextUseCase(
    registryConfig,
    new DefaultMacAddressResolver(),
    hostAdapters,
  );

  return new InstallPluginCliUseCase(
    resolveContext,
    registryConfig,
    new TerminalCliPresenter(),
    new QrCodeAuthAdapter(),
    hostAdapters,
  );
}
