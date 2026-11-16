import type { SelectHTMLAttributes } from 'react';

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'value'> & {
  value: string;
};

/**
 * Currencies in use today (ISO 4217, list one). Fund codes, precious metals, and test codes are
 * left out; so are withdrawn ones such as BGN, HRK, ANG, and SLL.
 */
const CURRENCY_CODES = (
  'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN ' +
  'BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP ' +
  'GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS ' +
  'KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR ' +
  'MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD ' +
  'RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP ' +
  'TRY TTD TWD TZS UAH UGX USD UYU UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ' +
  'ZWG'
).split(' ');

let currencyCache: { code: string; label: string }[] | undefined;

function currencies() {
  if (!currencyCache) {
    const names = new Intl.DisplayNames(['en'], { type: 'currency' });
    currencyCache = CURRENCY_CODES.map((code) => {
      const name = names.of(code);
      return { code, label: name && name !== code ? `${code} — ${name}` : code };
    });
  }
  return currencyCache;
}

/** A currency picker: every ISO 4217 code in use, shown with its English name. */
export function CurrencySelect({ value, ...rest }: SelectProps) {
  const list = currencies();
  return (
    <select value={value} {...rest}>
      {value && !list.some((c) => c.code === value) ? <option value={value}>{value}</option> : null}
      {list.map((c) => (
        <option key={c.code} value={c.code}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

type Zone = { id: string; label: string };

let zoneCache: { all: Set<string>; groups: { region: string; zones: Zone[] }[] } | undefined;

/** "UTC+01:00" for the zone's offset right now; "UTC" for zero. */
function utcOffset(timeZone: string, at: Date): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (!name) return '';
    return name === 'GMT' || name === 'GMT+00:00' ? 'UTC' : name.replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

/** The browser's IANA time zones, grouped by region, each labelled with its city and offset. */
function timeZones() {
  if (zoneCache) return zoneCache;
  const ids =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const now = new Date();
  const byRegion = new Map<string, Zone[]>();
  for (const id of ids) {
    const slash = id.indexOf('/');
    if (slash < 0) continue;
    const region = id.slice(0, slash);
    const place = id
      .slice(slash + 1)
      .replaceAll('_', ' ')
      .replaceAll('/', ' / ');
    const offset = utcOffset(id, now);
    const zones = byRegion.get(region) ?? [];
    zones.push({ id, label: offset ? `${place} (${offset})` : place });
    byRegion.set(region, zones);
  }
  const groups = [...byRegion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, zones]) => ({
      region,
      zones: zones.sort((a, b) => a.label.localeCompare(b.label)),
    }));
  zoneCache = { all: new Set(['UTC', ...ids]), groups };
  return zoneCache;
}

/** A time zone picker: UTC, then every IANA zone the browser knows, grouped by region. */
export function TimeZoneSelect({ value, ...rest }: SelectProps) {
  const { all, groups } = timeZones();
  return (
    <select value={value} {...rest}>
      {value && !all.has(value) ? <option value={value}>{value}</option> : null}
      <option value="UTC">UTC</option>
      {groups.map((g) => (
        <optgroup key={g.region} label={g.region}>
          {g.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
