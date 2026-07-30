declare module "qrcode-terminal" {
  interface QrcodeTerminalModule {
    generate(input: string, options: { small?: boolean }, callback: (qrcode: string) => void): void;
    generate(input: string, callback: (qrcode: string) => void): void;
  }

  const qrcodeTerminal: QrcodeTerminalModule;
  export default qrcodeTerminal;
}

declare module "supports-hyperlinks" {
  type StreamProbe = boolean | ((stream: NodeJS.WriteStream) => boolean);

  interface SupportsHyperlinksModule {
    (stream?: NodeJS.WriteStream): boolean;
    stdout?: StreamProbe;
    stderr?: StreamProbe;
  }

  const supportsHyperlinks: SupportsHyperlinksModule;
  export default supportsHyperlinks;
}
