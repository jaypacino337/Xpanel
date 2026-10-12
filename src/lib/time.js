// Time-zone helpers built on Intl, so no date library is needed.

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map();
function partsIn(utcMs, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

// How far the zone's wall clock is ahead of UTC at that instant.
function offsetMs(utcMs, tz) {
  const t = Math.floor(utcMs / 1000) * 1000;
  const p = partsIn(t, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
}

// Wall-clock time in tz -> epoch ms. month is 1-12.
export function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz);
  return second;
}

export function localParts(utcMs, tz) {
  return partsIn(utcMs, tz);
}

// Parses "YYYY-MM-DD HH:MM" (or with a T) as wall-clock time in tz; anything else via Date.parse.
export function parseLocalDateTime(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (m) return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, tz);
  return Date.parse(value);
}

// First slot time after `after` that is not in `taken`. Slots are { weekday, minute } in tz.
export function nextSlot(slots, tz, { after = Date.now(), taken = new Set(), days = 28 } = {}) {
  if (!slots.length) return null;
  const today = partsIn(after, tz);
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const weekday = d.getUTCDay();
    const daySlots = slots.filter((s) => s.weekday === weekday).sort((a, b) => a.minute - b.minute);
    for (const s of daySlots) {
      const t = zonedToUtc({
        year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        hour: Math.floor(s.minute / 60), minute: s.minute % 60,
      }, tz);
      if (t > after && !taken.has(t)) return t;
    }
  }
  return null;
}
