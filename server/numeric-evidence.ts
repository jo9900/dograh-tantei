export interface NumericAudioConflict {
  unit: string;
  liveValues: string[];
  recordedValues: string[];
}

const NUMERALS = '0-9〇零一二三四五六七八九十百千万两兩';
const DIGITS: Record<string, string> = {
  〇: '0',
  零: '0',
  一: '1',
  二: '2',
  两: '2',
  兩: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
};
const SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** Basic written integers only: do not guess decimals, approximate ranges or spoken omissions. */
function integer(text: string): string | null {
  const value = text.replace(/\s/g, '');
  if (!value || value.length > 64) return null;
  if (/^\d+$/.test(value)) return BigInt(value).toString();
  if ([...value].every((char) => char in DIGITS))
    return BigInt([...value].map((char) => DIGITS[char]).join('')).toString();
  if (/[0-9]/.test(value)) return null;
  const small = (part: string): number | null => {
    if (!part) return 0;
    let total = 0;
    let pending: number | null = null;
    let previousUnit = 10_000;
    for (const char of part) {
      if (char in DIGITS) {
        if (pending !== null && pending !== 0) return null;
        pending = Number(DIGITS[char]);
      } else {
        const unit = SMALL_UNITS[char];
        if (!unit || unit >= previousUnit || pending === 0) return null;
        total += (pending ?? 1) * unit;
        previousUnit = unit;
        pending = null;
      }
    }
    return total + (pending ?? 0);
  };
  const parts = value.split('万');
  if (parts.length > 2) return null;
  if (parts.length === 1) {
    const result = small(value);
    return result === null ? null : String(result);
  }
  const high = parts[0] ? small(parts[0]) : 1;
  const low = small(parts[1]!);
  return high === null || low === null || high === 0 ? null : String(high * 10_000 + low);
}

function quantities(text: string): Map<string, Set<string>> {
  const normalized = normalize(text);
  const pattern = new RegExp(
    `([${NUMERALS}]+(?:\\s+[${NUMERALS}]+)*)\\s*(box(?:es)?\\b|箱|个|個|件|台|人|名|泊|本|枚|袋)`,
    'gu',
  );
  const found = new Map<string, Set<string>>();
  for (const match of normalized.matchAll(pattern)) {
    // Never interpret the tail of 1.5, -2, 1,000 or an ASCII identifier as an integer.
    if (match.index && /[a-z0-9.,+\-−]/.test(normalized[match.index - 1]!)) continue;
    const number = integer(match[1]!);
    if (number === null) continue;
    const rawUnit = match[2]!;
    const unit =
      rawUnit === 'box' || rawUnit === 'boxes' ? '箱' : rawUnit === '個' ? '个' : rawUnit;
    if (!found.has(unit)) found.set(unit, new Set());
    found.get(unit)!.add(number);
  }
  return found;
}

/** A downgrade-only signal. Missing quantities are not contradictions; order and repetitions are ignored. */
export function numericAudioConflicts(
  liveCallerText: string,
  recordedCallerText: string,
): NumericAudioConflict[] {
  const live = quantities(liveCallerText);
  const recorded = quantities(recordedCallerText);
  const sort = (values: Set<string>) =>
    [...values].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const conflicts: NumericAudioConflict[] = [];
  for (const [unit, liveValues] of live) {
    const recordedValues = recorded.get(unit);
    if (
      !recordedValues ||
      (liveValues.size === recordedValues.size &&
        [...liveValues].every((value) => recordedValues.has(value)))
    )
      continue;
    conflicts.push({ unit, liveValues: sort(liveValues), recordedValues: sort(recordedValues) });
  }
  return conflicts;
}

/** Only apply a conflict to an assertion naming its unit or explicitly checking quantity/count. */
export function relevantNumericConflicts(
  assertion: string,
  conflicts: NumericAudioConflict[],
): NumericAudioConflict[] {
  const text = normalize(assertion);
  if (/(数量|數量|個数|個數|个数|箱数|箱數|\b(?:quantity|quantities|counts?)\b)/u.test(text))
    return [...conflicts];
  return conflicts.filter((conflict) =>
    conflict.unit === '箱'
      ? /箱|\bbox(?:es)?\b/u.test(text)
      : conflict.unit === '个'
        ? /个|個/u.test(text)
        : text.includes(conflict.unit),
  );
}
