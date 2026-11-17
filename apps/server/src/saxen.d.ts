declare module 'saxen' {
  export class Parser {
    on(event: 'openTag', handler: (name: string, attributes: () => Record<string, string>, decode: (text: string) => string) => void): this;
    on(event: 'error' | 'warn' | 'attention', handler: () => void): this;
    parse(xml: string): Error | undefined;
  }
}
