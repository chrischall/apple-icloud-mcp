import { InvalidArgumentError } from '../errors.js';

/**
 * Location arguments for the Maps tools.
 *
 * Apple's Maps Server API takes a location as a `"latitude,longitude"` string
 * everywhere, and additionally accepts a free-text ADDRESS on some endpoints
 * (directions origin/destination, the snapshot centre and pins) — but not on
 * others (ETAs are coordinates only). So a location argument is parsed ONCE,
 * here, into one of two shapes, and the tool decides which shapes it takes.
 *
 * Two rules:
 *  - Something shaped like coordinates IS coordinates. `"95,10"` is refused as
 *    an out-of-range latitude, never forwarded as an "address" that Apple
 *    would geocode into somewhere unrelated.
 *  - Numbers are re-rendered without exponent notation: `String(1e-7)` is
 *    `"1e-7"`, which is not a latitude any API parses.
 */

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export type ParsedLocation =
  | { kind: 'coordinate'; latitude: number; longitude: number; /** `lat,lng`, ready for a query string. */ value: string }
  | { kind: 'address'; /** The trimmed address text. */ value: string };

const NUM = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;
const COORD_RE = new RegExp(String.raw`^(${NUM})\s*,\s*(${NUM})$`);

/** Render a coordinate component with at most 8 decimals (≈1 mm) and no exponent. */
export function formatCoordinateNumber(n: number): string {
  if (Number.isInteger(n)) return String(n === 0 ? 0 : n);
  const fixed = n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '-0' ? '0' : fixed;
}

/** `lat,lng` for a coordinate pair. */
export function formatCoordinate(c: Coordinate): string {
  return `${formatCoordinateNumber(c.latitude)},${formatCoordinateNumber(c.longitude)}`;
}

/** Throws `InvalidArgumentError` unless latitude/longitude are finite and in range. */
export function assertCoordinateInRange(c: Coordinate, field: string, raw?: string): void {
  const shown = raw !== undefined ? ` "${raw}"` : '';
  if (!Number.isFinite(c.latitude) || c.latitude < -90 || c.latitude > 90) {
    throw new InvalidArgumentError(
      `${field}${shown} has latitude ${c.latitude}, which is outside -90…90.`,
      'Coordinates are "latitude,longitude" — latitude first, between -90 and 90.',
    );
  }
  if (!Number.isFinite(c.longitude) || c.longitude < -180 || c.longitude > 180) {
    throw new InvalidArgumentError(
      `${field}${shown} has longitude ${c.longitude}, which is outside -180…180.`,
      'Coordinates are "latitude,longitude" — longitude second, between -180 and 180.',
    );
  }
}

/**
 * Parse a location argument.
 *
 * `allowAddress: false` is for endpoints that only take coordinates; an
 * address there is refused with a pointer to `apple_maps_geocode` rather than
 * being sent to an endpoint that would reject it less legibly.
 */
export function parseLocation(raw: string, field: string, opts: { allowAddress: boolean }): ParsedLocation {
  const value = raw.trim();
  if (!value) {
    throw new InvalidArgumentError(`${field} is empty.`, 'Give "latitude,longitude"' + (opts.allowAddress ? ' or an address.' : '.'));
  }
  const m = COORD_RE.exec(value);
  if (m) {
    const c = { latitude: Number(m[1]), longitude: Number(m[2]) };
    assertCoordinateInRange(c, field, raw);
    return { kind: 'coordinate', ...c, value: formatCoordinate(c) };
  }
  if (!opts.allowAddress) {
    throw new InvalidArgumentError(
      `${field} "${raw}" must be coordinates as "latitude,longitude" — this Apple Maps endpoint does not accept addresses.`,
      'Turn an address into coordinates with apple_maps_geocode first (or use apple_maps_directions, which accepts addresses).',
    );
  }
  return { kind: 'address', value: value.replace(/\s+/g, ' ') };
}
