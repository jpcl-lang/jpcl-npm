/**
 * The value types a `.jp` document parses to, plus small helpers shared by the
 * parser, writer and config object.
 *
 * @module
 */

/** Any value a `.jp` document can hold. An empty value parses to `null`. */
export type JPValue = null | boolean | number | bigint | string | JPValue[] | JPObject;

/** A section or `{...}` object. */
export interface JPObject {
  [key: string]: JPValue;
}

/** Whether `value` is a plain object (`{}` or `Object.create(null)`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Set an own property, so that a key such as `__proto__` becomes ordinary data
 * instead of replacing the object's prototype.
 */
export function setOwn(target: object, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    (target as Record<string, unknown>)[key] = value;
  }
}
