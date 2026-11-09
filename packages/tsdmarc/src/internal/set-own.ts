// Shared by every module that copies keys from untrusted data into objects.

/**
 * Set `target[key]` as an own enumerable property. Plain assignment of a
 * key from untrusted data (`__proto__`) would change the prototype instead.
 */
export function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
