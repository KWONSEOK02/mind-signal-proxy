/** Returns current high-resolution time as a nanosecond decimal string. */
export function nowNs(): string {
  return process.hrtime.bigint().toString();
}
