import type { RegistryConfigAdapter, MacAddressResolver, HostAdapter } from "../domain/ports.ts";
import type { InstallContext, ParsedInstallCommand } from "../domain/types.ts";

export class ResolveInstallContextUseCase {
  private readonly registryConfig: RegistryConfigAdapter;
  private readonly macAddressResolver: MacAddressResolver;
  private readonly hostAdapters: Record<InstallContext["host"], HostAdapter>;

  constructor(
    registryConfig: RegistryConfigAdapter,
    macAddressResolver: MacAddressResolver,
    hostAdapters: Record<InstallContext["host"], HostAdapter>,
  ) {
    this.registryConfig = registryConfig;
    this.macAddressResolver = macAddressResolver;
    this.hostAdapters = hostAdapters;
  }

  async execute(command: ParsedInstallCommand): Promise<InstallContext> {
    const registry = await this.registryConfig.resolveRegistry(command.registry);
    return {
      command: command.command,
      host: command.host,
      environment: command.environment ?? "prod",
      registry,
      url: command.url?.trim() || undefined,
      mac: this.macAddressResolver.resolve(),
      channel: "openx",
    };
  }
}
