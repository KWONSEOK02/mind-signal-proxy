// Wave 2 T1-PROXY-C owns full implementation.
export class BeForwarder {
  forward(_payload: unknown): Promise<void> {
    throw new Error('not implemented — Wave 2 T1-PROXY-C');
  }

  connect(_backendUrl: string): Promise<void> {
    throw new Error('not implemented — Wave 2 T1-PROXY-C');
  }

  disconnect(): void {
    throw new Error('not implemented — Wave 2 T1-PROXY-C');
  }
}
