import type { VehicleCategory } from '@/config/siteConfig';

/**
 * Helpers shared by the live-inventory API route and the booking wizard so that
 * tariffs from the Google Sheets / n8n payload are read accurately
 * (numbers, "Rp 150.000", "150,000", alias column names, etc.) and are never
 * silently replaced by a lower fallback.
 */

/** Parse a price coming from Google Sheets / n8n into a positive integer (IDR). */
export function parseSheetPrice(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  }
  let text = String(value).trim().toLowerCase();
  if (!text) return undefined;

  // Shorthand like "150k" / "3jt" / "3 juta"
  const shorthand = text.match(/^(?:rp\.?\s*)?([\d.,]+)\s*(k|rb|ribu|jt|juta|m)$/i);
  if (shorthand) {
    const base = parseFloat(shorthand[1].replace(/\./g, '').replace(',', '.'));
    const unit = shorthand[2].toLowerCase();
    const mult = unit === 'k' || unit === 'rb' || unit === 'ribu' ? 1_000 : 1_000_000;
    const out = Math.round(base * mult);
    return Number.isFinite(out) && out > 0 ? out : undefined;
  }

  // Strip currency text and thousand separators ("Rp 1.950.000", "1,950,000")
  text = text.replace(/rp\.?|idr/g, '').replace(/[^\d.,]/g, '');
  if (!text) return undefined;
  // Drop decimal part like ",00" / ".00"
  text = text.replace(/[.,]\d{1,2}$/, '');
  const digits = text.replace(/[.,]/g, '');
  const num = Number(digits);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function pick(m: Record<string, any>, keys: string[]): unknown {
  for (const k of keys) {
    if (m[k] !== undefined && m[k] !== null && m[k] !== '') return m[k];
  }
  return undefined;
}

export interface ParsedTariff {
  dailyPrice?: number;
  weeklyPrice?: number;
  monthlyPrice?: number;
}

/** Read daily / weekly / monthly tariffs from a raw sheet row (supports alias columns). */
export function extractTariff(m: Record<string, any>): ParsedTariff {
  return {
    dailyPrice: parseSheetPrice(
      pick(m, ['dailyPrice', 'daily_price', 'hargaHarian', 'harga_harian', 'priceDaily', 'price_daily', 'daily', 'harian', 'Harga Harian'])
    ),
    weeklyPrice: parseSheetPrice(
      pick(m, ['weeklyPrice', 'weekly_price', 'hargaMingguan', 'harga_mingguan', 'priceWeekly', 'price_weekly', 'weekly', 'mingguan', 'Harga Mingguan'])
    ),
    monthlyPrice: parseSheetPrice(
      pick(m, ['monthlyPrice', 'monthly_price', 'hargaBulanan', 'harga_bulanan', 'priceMonthly', 'price_monthly', 'monthly', 'bulanan', 'Harga Bulanan'])
    ),
  };
}

const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Strict category matcher (never matches on an empty name). */
export function motorMatchesCategory(m: Record<string, any>, cat: VehicleCategory): boolean {
  const id = norm(cat.id);
  const fullName = norm(cat.name);
  const shortName = norm(cat.shortName);
  const candidates = [m.id, m.categoryId, m.category, m.name, m.title]
    .map(norm)
    .filter((c) => c.length >= 3);

  return candidates.some(
    (c) =>
      c === id ||
      c.includes(id) ||
      c === fullName ||
      c === shortName ||
      fullName.includes(c) ||
      shortName.includes(c)
  );
}

/** Merge live tariffs onto a category; keeps official defaults only when the sheet has no valid value. */
export function applyTariff<T extends VehicleCategory>(cat: T, m: Record<string, any> | undefined): T {
  if (!m) return cat;
  const t = extractTariff(m);
  return {
    ...cat,
    dailyPrice: t.dailyPrice ?? cat.dailyPrice,
    weeklyPrice: t.weeklyPrice ?? cat.weeklyPrice,
    monthlyPrice: t.monthlyPrice ?? cat.monthlyPrice,
  };
}
