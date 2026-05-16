// Wave 2 T1-PROXY-F owns full implementation.
export class PendingRegistry {
  register(_key: string, _value: unknown): void {
    throw new Error('not implemented — Wave 2 T1-PROXY-F');
  }

  resolve(_key: string): unknown {
    throw new Error('not implemented — Wave 2 T1-PROXY-F');
  }

  expire(): void {
    throw new Error('not implemented — Wave 2 T1-PROXY-F');
  }
}
