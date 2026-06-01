export interface CanonicalizeOptions {
  omitNullish?: boolean;
}

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson | undefined };

export function canonicalize(value: CanonicalJson, options: CanonicalizeOptions = {}): string {
  return serialize(value, options);
}

function serialize(value: CanonicalJson | undefined, options: CanonicalizeOptions): string {
  if (value === undefined) {
    throw new TypeError('Cannot canonicalize undefined as a root value');
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cannot canonicalize non-finite numbers');
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => serialize(item, options)).join(',')}]`;
  }

  const properties = Object.entries(value)
    .filter(([, item]) => item !== undefined && !(options.omitNullish && item === null))
    .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, options)}`);

  return `{${properties.join(',')}}`;
}

function compareUtf16CodeUnits(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);

  for (let i = 0; i < limit; i++) {
    const leftCodeUnit = left.charCodeAt(i);
    const rightCodeUnit = right.charCodeAt(i);
    if (leftCodeUnit !== rightCodeUnit) return leftCodeUnit - rightCodeUnit;
  }

  return left.length - right.length;
}
