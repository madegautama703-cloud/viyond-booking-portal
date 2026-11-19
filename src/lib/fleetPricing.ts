import type { VehicleCategory } from '@/config/siteConfig';

/**
 * Helpers shared by the live-inventory API route and the booking wizard so that
 * tariffs & ready-unit counts from Google Sheets / n8n are read accurately
 * (case-insensitive column names like Harga_Harian, Harga_Mingguan, Harga_Bulanan,
 * READY, numbers, "Rp 150.000", "150,000", etc.) without being overwritten by static defaults.
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

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Case-insensitive & separator-insensitive field picker for Google Sheets / n8n rows. */
export function pickFieldCI(m: Record<string, any>, candidateKeys: string[]): unknown {
  if (!m || typeof m !== 'object') return undefined;
  const normalizedTargets = new Set(candidateKeys.map(normKey));
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined || v === null || v === '') continue;
    if (normalizedTargets.has(normKey(k))) {
      return v;
    }
  }
  return undefined;
}

export interface ParsedTariff {
  dailyPrice?: number;
  weeklyPrice?: number;
  monthlyPrice?: number;
}

/** Read daily / weekly / monthly tariffs from a raw sheet row (supports Harga_Harian, dailyPrice, etc.). */
export function extractTariff(m: Record<string, any>): ParsedTariff {
  return {
    dailyPrice: parseSheetPrice(
      pickFieldCI(m, [
        'dailyPrice',
        'daily_price',
        'Harga_Harian',
        'hargaHarian',
        'harga_harian',
        'priceDaily',
        'daily',
        'harian',
      ])
    ),
    weeklyPrice: parseSheetPrice(
      pickFieldCI(m, [
        'weeklyPrice',
        'weekly_price',
        'Harga_Mingguan',
        'hargaMingguan',
        'harga_mingguan',
        'priceWeekly',
        'weekly',
        'mingguan',
      ])
    ),
    monthlyPrice: parseSheetPrice(
      pickFieldCI(m, [
        'monthlyPrice',
        'monthly_price',
        'Harga_Bulanan',
        'hargaBulanan',
        'harga_bulanan',
        'priceMonthly',
        'monthly',
        'bulanan',
      ])
    ),
  };
}

/** Extract READY unit count from a raw n8n / Google Sheets row. */
export function extractReadyCount(m: Record<string, any>): number {
  const statusRaw = pickFieldCI(m, ['status', 'status_unit', 'Status']);
  const statusUpper = String(statusRaw || '').trim().toUpperCase();
  if (['SOLD_OUT', 'SOLDOUT', 'DISEWA', 'BENGKEL'].includes(statusUpper)) {
    return 0;
  }

  const rawCount = pickFieldCI(m, [
    'availableCount',
    'availableUnits',
    'readyUnits',
    'READY',
    'ready',
    'readyCount',
    'jumlahReady',
    'stokReady',
    'stock',
    'stok',
    'tersedia',
    'count',
  ]);

  if (rawCount !== undefined && rawCount !== null && rawCount !== '') {
    const parsed = Number(String(rawCount).replace(/[^\d.-]/g, ''));
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed));
    }
  }

  return statusUpper === 'READY' ? 1 : 0;
}

const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Strict category matcher (supports category, name, title, Nama_Motor, Kategori, model, etc.). */
export function motorMatchesCategory(m: Record<string, any>, cat: VehicleCategory): boolean {
  const id = norm(cat.id);
  const fullName = norm(cat.name);
  const shortName = norm(cat.shortName);
  const candidates = [
    m.id,
    m.categoryId,
    m.category,
    m.name,
    m.title,
    pickFieldCI(m, ['Nama_Motor', 'namaMotor', 'Kategori', 'kategori', 'model', 'tipe', 'unit']),
  ]
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
