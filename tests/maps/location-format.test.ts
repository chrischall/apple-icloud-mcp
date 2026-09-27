import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '../../src/errors.js';
import { formatDistance, formatDuration } from '../../src/maps/format.js';
import {
  assertCoordinateInRange,
  formatCoordinate,
  formatCoordinateNumber,
  parseLocation,
} from '../../src/maps/location.js';

describe('formatCoordinateNumber', () => {
  it('renders integers, decimals and tiny values without exponent notation', () => {
    expect(formatCoordinateNumber(37)).toBe('37');
    expect(formatCoordinateNumber(-0)).toBe('0');
    expect(formatCoordinateNumber(0)).toBe('0');
    expect(formatCoordinateNumber(37.3301996)).toBe('37.3301996');
    expect(formatCoordinateNumber(1e-7)).toBe('0.0000001');
    expect(formatCoordinateNumber(-122.5)).toBe('-122.5');
    // Rounds to 8 decimals; a sub-millimetre negative collapses to 0, never "-0".
    expect(formatCoordinateNumber(-1e-10)).toBe('0');
    expect(formatCoordinateNumber(37.325565611301944)).toBe('37.32556561');
  });

  it('formats a pair', () => {
    expect(formatCoordinate({ latitude: 37.78, longitude: -122.42 })).toBe('37.78,-122.42');
  });
});

describe('assertCoordinateInRange', () => {
  it('accepts the boundaries', () => {
    expect(() => assertCoordinateInRange({ latitude: 90, longitude: -180 }, 'x')).not.toThrow();
    expect(() => assertCoordinateInRange({ latitude: -90, longitude: 180 }, 'x')).not.toThrow();
  });

  it('refuses out-of-range and non-finite values, naming the field and raw value', () => {
    expect(() => assertCoordinateInRange({ latitude: 91, longitude: 0 }, 'origin', '91,0')).toThrow(/origin "91,0" has latitude 91/);
    expect(() => assertCoordinateInRange({ latitude: 0, longitude: 181 }, 'near')).toThrow(/near has longitude 181/);
    expect(() => assertCoordinateInRange({ latitude: Number.NaN, longitude: 0 }, 'x')).toThrow(InvalidArgumentError);
    expect(() => assertCoordinateInRange({ latitude: 0, longitude: Number.POSITIVE_INFINITY }, 'x')).toThrow(InvalidArgumentError);
  });
});

describe('parseLocation', () => {
  it('parses coordinates with spaces, signs and bare decimals', () => {
    expect(parseLocation(' 37.7857 , -122.4011 ', 'origin', { allowAddress: true })).toEqual({
      kind: 'coordinate',
      latitude: 37.7857,
      longitude: -122.4011,
      value: '37.7857,-122.4011',
    });
    expect(parseLocation('+1.,.5', 'x', { allowAddress: false })).toMatchObject({ value: '1,0.5' });
  });

  it('treats coordinate-shaped but out-of-range input as an error, never an address', () => {
    expect(() => parseLocation('95,10', 'destination', { allowAddress: true })).toThrow(/latitude 95/);
    expect(() => parseLocation('10,190', 'destination', { allowAddress: true })).toThrow(/longitude 190/);
  });

  it('returns an address with collapsed whitespace when addresses are allowed', () => {
    expect(parseLocation('  1 Infinite  Loop,\nCupertino ', 'origin', { allowAddress: true })).toEqual({
      kind: 'address',
      value: '1 Infinite Loop, Cupertino',
    });
  });

  it('refuses an address where only coordinates are accepted, pointing at geocode', () => {
    try {
      parseLocation('Apple Park', 'destinations[2]', { allowAddress: false });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidArgumentError);
      expect((err as Error).message).toMatch(/destinations\[2\] "Apple Park" must be coordinates/);
      expect((err as InvalidArgumentError).hint).toMatch(/apple_maps_geocode/);
    }
  });

  it('refuses empty input with a hint matching what is allowed', () => {
    try {
      parseLocation('   ', 'origin', { allowAddress: true });
      expect.unreachable();
    } catch (err) {
      expect((err as InvalidArgumentError).hint).toMatch(/or an address/);
    }
    try {
      parseLocation('', 'origin', { allowAddress: false });
      expect.unreachable();
    } catch (err) {
      expect((err as InvalidArgumentError).hint).not.toMatch(/address/);
    }
  });
});

describe('formatDistance', () => {
  it('uses feet/metres under a tenth of a mile', () => {
    expect(formatDistance(0)).toBe('0 ft / 0 m');
    expect(formatDistance(37)).toBe('121 ft / 37 m');
  });

  it('uses miles/km with one decimal, whole numbers from 100', () => {
    expect(formatDistance(19_800)).toBe('12.3 mi / 19.8 km');
    expect(formatDistance(161)).toBe('0.1 mi / 0.2 km');
    expect(formatDistance(150_000)).toBe('93.2 mi / 150 km');
    expect(formatDistance(400_000)).toBe('249 mi / 400 km');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(11)).toBe('11 s');
    expect(formatDuration(59.4)).toBe('59 s');
    expect(formatDuration(59.6)).toBe('1 min');
    expect(formatDuration(506)).toBe('8 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(3900)).toBe('1 h 5 min');
    expect(formatDuration(3599)).toBe('1 h');
    expect(formatDuration(30 * 3600 + 60)).toBe('30 h 1 min');
  });
});
