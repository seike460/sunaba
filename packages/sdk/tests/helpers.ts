/** Minimal fake for the LambdaMicrovmsClient surface sunaba uses. */
export class FakeMicrovmsClient {
  readonly calls: unknown[] = [];
  constructor(private handler: (command: any) => unknown = () => ({})) {}
  async send(command: unknown): Promise<unknown> {
    this.calls.push(command);
    return this.handler(command);
  }
  /** Calls whose constructor name matches (e.g. "RunMicrovmCommand"). */
  callsOf(name: string): any[] {
    return this.calls.filter((c) => (c as any).constructor.name === name) as any[];
  }
}

export const ARN = "arn:aws:lambda:us-east-1:123456789012:microvm-image:demo";
