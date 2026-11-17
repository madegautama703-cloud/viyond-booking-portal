import { NextRequest, NextResponse } from 'next/server';
import { masterDb } from '@/lib/masterDbStore';

// Endpoint 2 Webhook URL (Production n8n): POST /webhook/web-booking-kyc
const PRODUCTION_CREATE_BOOKING_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  process.env.N8N_CREATE_BOOKING_WEBHOOK_URL ||
  process.env.N8N_WEB_BOOKING_WEBHOOK_URL ||
  'https://n8n.srv2075779.hstgr.cloud/webhook/web-booking-kyc';

export async function POST(req: NextRequest) {
  const startTime = performance.now();
  let payload: Record<string, any> = {};

  try {
    payload = await req.json();
  } catch (err) {
    console.error('[API /api/n8n/create-booking] Failed to parse request JSON:', err);
    return NextResponse.json(
      { success: false, message: 'Invalid JSON request payload' },
      { status: 400 }
    );
  }

  // Handle Owner Telegram Bot decision if delivered to this endpoint
  if (payload.action === 'telegram_owner_decision') {
    const { orderId, decision } = payload;
    const order = masterDb.dataPesananKyc.find((o) => o.orderId === orderId);
    if (!order) {
      return NextResponse.json({ status: 'error', message: 'Order not found' }, { status: 404 });
    }

    if (decision === 'approve') {
      const lockedPlate = masterDb.lockAvailableUnitForOrder(order.categoryId) || 'DK 4821 FBV';
      order.status = 'cod_approved_locked';
      order.assignedPlate = lockedPlate;
      order.whatsappMessagePreview = `E-RECEIPT TERKONFIRMASI (#${order.orderId}): Halo ${order.fullName}, pesanan COD Anda untuk ${order.categoryName} (Pelat: ${lockedPlate}) telah disetujui Owner! Kurir kami sedang menuju ${order.hotelAndRoom} untuk pengantaran pukul ${order.deliveryTime}.`;
    } else {
      order.status = 'rejected';
    }

    return NextResponse.json({
      status: 'ok',
      order,
      categories: masterDb.getPublicAggregatedInventory(),
      inventarisMotor: masterDb.inventarisMotor,
    });
  }

  // IF Node: OpenAI Vision OCR Clarity Check
  // "Jika BURAM: Langsung kirim respons berstatus error_blur dengan pesan peringatan.
  // Turis bisa langsung mengganti fotonya detik itu juga di halaman web tanpa harus mengulang pengisian dari awal."
  const idCardStatus = String(payload.idCardStatus || '').toLowerCase();
  const isBlurry =
    idCardStatus === 'blurry' ||
    idCardStatus === 'buram' ||
    payload.ocrStatus === 'BURAM' ||
    payload.simulateBlur === true;

  if (isBlurry) {
    console.warn('[API /api/n8n/create-booking] Rejected blurry ID card photo (OpenAI Vision IF Node).');
    return NextResponse.json(
      {
        success: false,
        status: 'error_blur',
        ocrStatus: 'BURAM',
        error:
          'AI Vision OCR detected glare/blur on 1. Passport / ID Card (KTP). Please retake photo clearly without flash before submitting.',
        message:
          'AI Vision OCR detected glare/blur on 1. Passport / ID Card (KTP). Please retake photo clearly without flash before submitting.',
      },
      { status: 422 }
    );
  }

  // Validation: ensure mandatory fields exist
  const customerName = String(payload.customerName || payload.fullName || '').trim();
  const whatsapp = String(payload.whatsapp || payload.whatsappNumber || '').trim();
  const startDate = String(payload.startDate || '').trim();
  const endDate = String(payload.endDate || '').trim();

  const missingFields: string[] = [];
  if (!customerName) missingFields.push('customerName');
  if (!whatsapp) missingFields.push('whatsapp');
  if (!startDate) missingFields.push('startDate');
  if (!endDate) missingFields.push('endDate');

  if (missingFields.length > 0) {
    console.warn('[API /api/n8n/create-booking] Blocked incomplete request. Missing fields:', missingFields);
    return NextResponse.json(
      {
        success: false,
        message: `Validation failed: missing required booking fields [${missingFields.join(', ')}]`,
        missingFields,
      },
      { status: 400 }
    );
  }

  // Normalization check for optional online plate lock on successful n8n response
  const categoryId = String(payload.categoryId || payload.unitId || 'nmax').toLowerCase();
  const rawPm = String(payload.paymentMethod || '').toUpperCase();
  const isOnline = rawPm.includes('ONLINE') || rawPm.includes('INSTANT') || rawPm.includes('QRIS');

  // Log incoming booking request in console
  console.log('[API /api/n8n/create-booking] === INCOMING BOOKING REQUEST ===');
  console.log('[API /api/n8n/create-booking] Target n8n Webhook:', PRODUCTION_CREATE_BOOKING_WEBHOOK_URL);
  console.log('[API /api/n8n/create-booking] Payload:', JSON.stringify(payload, null, 2));

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    // Forward request to n8n webhook with cache: 'no-store'
    const n8nResponse = await fetch(PRODUCTION_CREATE_BOOKING_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const elapsedMs = Math.round(performance.now() - startTime);
    const rawText = await n8nResponse.text();

    let responseData: any = {};
    if (rawText && rawText.trim().length > 0) {
      try {
        responseData = JSON.parse(rawText);
      } catch {
        responseData = { message: rawText };
      }
    }

    console.log('[API /api/n8n/create-booking] === N8N WEBHOOK RESPONSE ===');
    console.log('[API /api/n8n/create-booking] Latency:', `${elapsedMs}ms`);
    console.log('[API /api/n8n/create-booking] Status:', n8nResponse.status);
    console.log('[API /api/n8n/create-booking] Data:', JSON.stringify(responseData, null, 2));

    if (n8nResponse.ok) {
      if (isOnline) {
        masterDb.lockAvailableUnitForOrder(categoryId);
      }
      return NextResponse.json(responseData, {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    // If n8n responded with 422 (e.g. n8n OpenAI Vision node flagged photo as blurry)
    if (n8nResponse.status === 422 || responseData?.status === 'error_blur') {
      return NextResponse.json(responseData, { status: 422 });
    }

    // Return 502 Bad Gateway with original n8n error details (no mock/dummy fallback)
    const n8nErrorMessage =
      responseData?.message ||
      responseData?.error ||
      rawText ||
      `n8n webhook responded with HTTP ${n8nResponse.status}`;

    console.error('[API /api/n8n/create-booking] n8n webhook returned error:', n8nResponse.status, n8nErrorMessage);

    return NextResponse.json(
      {
        success: false,
        status: 'bad_gateway',
        message: `n8n webhook error (HTTP ${n8nResponse.status}): ${n8nErrorMessage}`,
        error: n8nErrorMessage,
        upstreamStatus: n8nResponse.status,
        upstreamResponse: responseData,
        webhookUrl: PRODUCTION_CREATE_BOOKING_WEBHOOK_URL,
      },
      {
        status: 502,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(
      '[API /api/n8n/create-booking] Failed to reach n8n webhook:',
      errorMessage
    );

    return NextResponse.json(
      {
        success: false,
        status: 'bad_gateway',
        message: `Failed to reach n8n webhook: ${errorMessage}`,
        error: errorMessage,
        webhookUrl: PRODUCTION_CREATE_BOOKING_WEBHOOK_URL,
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
