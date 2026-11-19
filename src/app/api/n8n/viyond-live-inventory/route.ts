import { NextRequest, NextResponse } from 'next/server';
import { masterDb } from '@/lib/masterDbStore';
import { INITIAL_INVENTARIS_MOTOR, VEHICLE_CATEGORIES, VehicleCategory } from '@/config/siteConfig';
import { applyTariff, extractReadyCount, motorMatchesCategory, pickFieldCI } from '@/lib/fleetPricing';

export const dynamic = 'force-dynamic';

function getN8nBaseUrl(): string {
  return (process.env.N8N_WEBHOOK_BASE_URL || 'https://n8n.viyond.tech')
    .trim()
    .replace(/\/+$/, '');
}

function formatFetchError(err: unknown): { message: string; cause?: string } {
  const message = err instanceof Error ? err.message : String(err);
  let cause: string | undefined;
  if (err instanceof Error && 'cause' in err && err.cause) {
    if (err.cause instanceof Error) {
      const code = (err.cause as { code?: string }).code;
      cause = code ? `${err.cause.message} (${code})` : err.cause.message;
    } else {
      cause = String(err.cause);
    }
  }
  return {
    message: cause ? `${message} (cause: ${cause})` : message,
    cause,
  };
}

interface EnrichedCategory extends VehicleCategory {
  availableUnits: number;
  totalFleetUnits: number;
  isAvailable: boolean;
}

interface RawMotorItem {
  id?: string;
  categoryId?: string;
  category?: string;
  name?: string;
  availableCount?: number | string;
  availableUnits?: number | string;
  readyUnits?: number | string;
  stock?: number | string;
  status?: string;
  dailyPrice?: number | string;
  weeklyPrice?: number | string;
  monthlyPrice?: number | string;
  totalUnits?: number | string;
}

/**
 * Normalizes raw motors array from n8n / Google Sheets "Aggregate Ready Stock" node
 * Maps categories: "NMAX", "PCX", "Scoopy", "Vario", "Fazzio"
 */
function mapMotorsToCategories(motors: RawMotorItem[]): EnrichedCategory[] {
  if (!motors || !Array.isArray(motors) || motors.length === 0) {
    return masterDb.getPublicAggregatedInventory();
  }
  return VEHICLE_CATEGORIES.map((cat) => {
    const matched = motors.find((m) => motorMatchesCategory(m as any, cat));

    if (matched) {
      const count = extractReadyCount(matched as any);
      const isAvailable = count > 0;
      const rawTotal = pickFieldCI(matched as any, ['totalUnits', 'total_units', 'total', 'jumlahUnit']);

      // Tariffs & ready counts come directly from the live Google Sheets / n8n row
      return {
        ...applyTariff(cat, matched as any),
        availableUnits: count,
        totalFleetUnits: rawTotal ? Number(rawTotal) || Math.max(count, 3) : Math.max(count, 3),
        isAvailable,
      };
    }

    // Default fallback if category not present in remote payload
    const defaultReadyCount =
      INITIAL_INVENTARIS_MOTOR.filter(
        (u) => u.categoryId === cat.id && u.status === 'READY'
      ).length || 2;

    return {
      ...cat,
      availableUnits: defaultReadyCount,
      totalFleetUnits: Math.max(defaultReadyCount + 1, 3),
      isAvailable: defaultReadyCount > 0,
    };
  });
}

// Endpoint 1: GET /webhook/viyond-live-inventory (Cek Stok & Zona)
export async function GET(req: NextRequest) {
  const startTime = performance.now();
  const url = req.nextUrl || new URL(req.url, 'http://localhost:3000');
  const searchParams = url.searchParams;

  // Target webhook is fixed server-side using N8N_WEBHOOK_BASE_URL (default https://n8n.viyond.tech)
  const rawRequestedEndpoint = `${getN8nBaseUrl()}/viyond-live-inventory`;

  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  // Build target URL with date range query parameters for n8n webhook
  let requestedEndpoint = rawRequestedEndpoint;
  try {
    const urlObj = new URL(rawRequestedEndpoint);
    if (startDate) urlObj.searchParams.set('startDate', startDate);
    if (endDate) urlObj.searchParams.set('endDate', endDate);
    requestedEndpoint = urlObj.toString();
  } catch {
    // If not a valid absolute URL, leave as is
  }

  let categories: EnrichedCategory[] = [];
  let zones = masterDb.zonaOngkir;
  let rawIncomingMotors: RawMotorItem[] | null = null;

  // Pull real live data from Production n8n Webhook (no mock/dummy fallback on error)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const webhookHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-viyond-secret': process.env.N8N_WEBHOOK_SECRET || '',
    };

    const n8nResponse = await fetch(requestedEndpoint, {
      method: 'GET',
      headers: webhookHeaders,
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const rawText = await n8nResponse.text();
    let rawPayload: any = {};
    if (rawText && rawText.trim().length > 0) {
      try {
        rawPayload = JSON.parse(rawText);
      } catch {
        rawPayload = { message: rawText };
      }
    }

    if (!n8nResponse.ok) {
      const n8nErrorMessage =
        rawPayload?.message ||
        rawPayload?.error ||
        rawText ||
        `n8n inventory webhook responded with HTTP ${n8nResponse.status}`;

      console.error('[API /api/n8n/viyond-live-inventory] n8n webhook error:', n8nResponse.status, n8nErrorMessage);

      return NextResponse.json(
        {
          success: false,
          status: 'bad_gateway',
          message: `n8n inventory webhook error (HTTP ${n8nResponse.status}): ${n8nErrorMessage}`,
          error: n8nErrorMessage,
          upstreamStatus: n8nResponse.status,
          upstreamResponse: rawPayload,
          webhookUrl: requestedEndpoint,
        },
        { status: 502 }
      );
    }

    // Normalize standard n8n / Google Sheets response structures
    let incomingData = rawPayload;
    const isMotorRow = (row: any) =>
      row &&
      typeof row === 'object' &&
      !Array.isArray(row.motors) &&
      !Array.isArray(row.categories) &&
      Boolean(
        pickFieldCI(row, [
          'category',
          'name',
          'Nama_Motor',
          'Kategori',
          'Harga_Harian',
          'dailyPrice',
          'READY',
          'availableCount',
          'availableUnits',
          'stock',
        ]) !== undefined
      );

    if (Array.isArray(rawPayload) && rawPayload.length > 0) {
      const unwrapped = rawPayload.map((item: any) => (item && item.json ? item.json : item));
      if (isMotorRow(unwrapped[0])) {
        incomingData = { motors: unwrapped };
      } else {
        incomingData = unwrapped[0];
      }
    } else if (rawPayload?.data) {
      incomingData = Array.isArray(rawPayload.data)
        ? { motors: rawPayload.data }
        : rawPayload.data;
    } else if (rawPayload?.inventory) {
      incomingData = Array.isArray(rawPayload.inventory)
        ? { motors: rawPayload.inventory }
        : rawPayload.inventory;
    }

    if (incomingData?.motors && Array.isArray(incomingData.motors)) {
      rawIncomingMotors = incomingData.motors;
      categories = mapMotorsToCategories(incomingData.motors);
    } else if (incomingData?.inventory && Array.isArray(incomingData.inventory)) {
      rawIncomingMotors = incomingData.inventory;
      categories = mapMotorsToCategories(incomingData.inventory);
    } else if (incomingData?.categories && Array.isArray(incomingData.categories)) {
      rawIncomingMotors = incomingData.categories;
      categories = mapMotorsToCategories(incomingData.categories);
    }

    if (incomingData?.zones && Array.isArray(incomingData.zones)) {
      zones = incomingData.zones.map((z: any) => ({
        code: z.code || 'ZONA-1',
        name: z.name || `Zona ${z.code}`,
        coverage: z.coverage || z.areaNames || '',
        fee: typeof z.fee === 'number' ? z.fee : Number(z.fee) || 0,
        id: z.id || z.code?.toLowerCase() || 'zona-1',
        labelEn: z.name || z.labelEn || z.code,
        labelId: z.name || z.labelId || z.code,
        areaNames: z.coverage || z.areaNames || '',
      }));
    }

    const elapsedMs = Math.max(12, Math.round(performance.now() - startTime));

    return NextResponse.json(
      {
        status: 'ok',
        syncedAt: new Date().toISOString(),
        latencyMs: elapsedMs,
        source: `Production n8n Webhook (${requestedEndpoint})`,
        isLiveProduction: true,
        webhookUrl: requestedEndpoint,
        categories,
        zones,
        motors: rawIncomingMotors,
      },
      {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      }
    );
  } catch (err) {
    const { message: detailedError, cause } = formatFetchError(err);
    console.error(
      '[API /api/n8n/viyond-live-inventory] Failed to reach n8n webhook:',
      requestedEndpoint,
      detailedError
    );

    return NextResponse.json(
      {
        success: false,
        status: 'bad_gateway',
        message: `Failed to reach n8n inventory webhook (${requestedEndpoint}): ${detailedError}`,
        error: detailedError,
        cause,
        webhookUrl: requestedEndpoint,
      },
      {
        status: 502,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      }
    );
  }
}

// Simulates Telegram Bot Staff /stok command or [Tukar Unit / Swap]
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, categoryId, unitId, status, forceSoldOut } = body;

    if (action === 'toggle_category' && categoryId) {
      masterDb.toggleCategoryStockForUat(categoryId, forceSoldOut);
    } else if (action === 'update_unit' && unitId && status) {
      masterDb.updateSingleUnitStatus(unitId, status);
    } else if (action === 'reset_db') {
      masterDb.inventarisMotor = INITIAL_INVENTARIS_MOTOR.map((u) => ({ ...u }));
    }

    return NextResponse.json({
      status: 'ok',
      message: 'Telegram Bot /stok synced with Master DB',
      categories: masterDb.getPublicAggregatedInventory(),
      inventarisMotor: masterDb.inventarisMotor,
    });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', message: error instanceof Error ? error.message : 'Failed to update stock' },
      { status: 400 }
    );
  }
}
