import { NextRequest, NextResponse } from 'next/server';

type KycDocType = 'passport' | 'selfie' | 'ticket' | 'hotel';

interface VerifyKycRequestBody {
  imageBase64?: string;
  docType?: string;
  isTestDemo?: boolean;
}

interface ExtractedKycData {
  nama?: string;
  nomor_id?: string;
  negara?: string;
}

interface VerifyKycResponse {
  valid: boolean;
  reason: string;
  extractedData?: ExtractedKycData;
}

const DOC_TYPE_CRITERIA: Record<KycDocType, string> = {
  passport:
    'Dokumen identitas utama yang SAH (valid: true) meliputi: e-KTP Indonesia, SIM (Surat Izin Mengemudi Indonesia / International Driving Permit), MAUPUN Paspor asli (WNI/WNA). Foto harus terlihat jelas, tidak buram/terpotong parah, tidak tertutup pantulan cahaya (glare), serta nama lengkap dan nomor identitas (NIK / No. SIM / No. Paspor) terbaca. PENTING: JANGAN pernah menolak foto hanya karena dokumen tersebut adalah KTP atau SIM dan bukan paspor.',
  selfie:
    'Pastikan terlihat wajah seseorang secara jelas yang sedang memegang kartu identitas (KTP, SIM, atau Paspor) di dekat wajah/dadanya. JANGAN mewajibkan nama atau nomor identitas pada kartu terbaca jelas — jarak kamera selfie membuat tulisan kartu terlalu kecil, dan pembacaan teks sudah dilakukan pada dokumen identitas utama. Set "valid": false HANYA jika: (1) tidak ada wajah manusia, (2) wajah tertutup masker atau gelap total, atau (3) orang tersebut sama sekali tidak terlihat memegang kartu/dokumen identitas. Di luar itu, set "valid": true. Isi extractedData hanya jika terbaca; boleh dikosongkan.',
  ticket:
    'Dokumen harus berupa bukti atau e-ticket penerbangan pulang (return flight ticket) dengan nama penumpang dan/atau tanggal/rute penerbangan yang terbaca jelas.',
  hotel:
    'Dokumen harus berupa bukti reservasi hotel, vila, atau penginapan di Bali dengan nama tempat/properti penginapan yang terbaca jelas.',
};

function isValidDocType(value: unknown): value is KycDocType {
  return value === 'passport' || value === 'selfie' || value === 'ticket' || value === 'hotel';
}

function normalizeImageDataUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('data:')) {
    return trimmed;
  }
  return `data:image/jpeg;base64,${trimmed}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as VerifyKycRequestBody;
    const { imageBase64, docType, isTestDemo } = body;

    // UAT Demo bypass: return verified test data immediately without calling OpenAI Vision
    if (isTestDemo === true) {
      return NextResponse.json({
        valid: true,
        reason: 'Data uji UAT terverifikasi',
        extractedData: {
          nama: 'MADE GAUTAMA (TEST)',
          nomor_id: '5171012345670001',
          negara: 'Indonesia',
        },
      });
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        {
          valid: false,
          reason: 'OPENAI_API_KEY belum dikonfigurasi di environment server.',
          error: 'OPENAI_API_KEY is not set in environment variables.',
        },
        { status: 500 }
      );
    }

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return NextResponse.json(
        {
          valid: false,
          reason: 'Gambar (imageBase64) wajib disertakan untuk verifikasi.',
        },
        { status: 400 }
      );
    }

    if (!isValidDocType(docType)) {
      return NextResponse.json(
        {
          valid: false,
          reason: "docType tidak valid. Gunakan salah satu dari: 'passport', 'selfie', 'ticket', 'hotel'.",
        },
        { status: 400 }
      );
    }

    if (imageBase64.startsWith('data:application/pdf')) {
      return NextResponse.json(
        {
          valid: false,
          reason:
            'Format PDF belum didukung untuk validasi AI Vision secara langsung. Mohon unggah foto atau screenshot dokumen (JPG/PNG/WEBP).',
        },
        { status: 400 }
      );
    }

    const imageUrl = normalizeImageDataUrl(imageBase64);
    const criteria = DOC_TYPE_CRITERIA[docType];

    const systemPrompt = `Anda adalah sistem validator AI Vision OCR KYC untuk layanan rental motor di Bali (Viyond).
Tugas Anda adalah memverifikasi apakah gambar yang diunggah pengguna valid untuk jenis dokumen "${docType}".

Kriteria validasi untuk "${docType}":
${criteria}

Aturan output:
Kembalikan HANYA JSON object yang valid dengan struktur persis berikut:
{
  "valid": boolean,
  "reason": "Penjelasan singkat dan jelas dalam Bahasa Indonesia mengenai hasil validasi atau alasan penolakan jika tidak valid",
  "extractedData": {
    "nama": "Nama lengkap jika terbaca (opsional)",
    "nomor_id": "Nomor KTP/SIM/Paspor atau kode booking jika terbaca (opsional)",
    "negara": "Negara/kewarganegaraan jika terbaca (opsional)"
  }
}

${
  docType === 'selfie'
    ? 'Untuk selfie: tolak (valid false) HANYA jika tidak ada wajah manusia, wajah tertutup masker/gelap total, atau orang tidak terlihat memegang kartu/dokumen identitas. Teks pada kartu TIDAK perlu terbaca jelas dan jangan dijadikan alasan penolakan.'
    : 'Jika gambar buram, terpotong parah, bukan dokumen yang diminta, atau teks penting tidak dapat dibaca, set "valid": false dan jelaskan alasannya di "reason" agar pengguna tahu harus mengunggah ulang apa.'
}`;

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 400,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  docType === 'passport'
                    ? 'Analisis gambar berikut untuk verifikasi KYC identitas utama. KTP (e-KTP Indonesia), SIM (Indonesia / International Driving Permit), maupun Paspor semuanya SAH (valid: true) selama foto jelas serta nama dan nomor identitas terbaca. Jangan tolak jika dokumen berupa KTP atau SIM.'
                    : docType === 'selfie'
                    ? 'Analisis gambar berikut untuk verifikasi KYC selfie memegang identitas. Valid jika terlihat wajah manusia yang jelas dan orang tersebut memegang kartu identitas (KTP, SIM, atau Paspor) di dekat wajah/dada. Teks pada kartu TIDAK perlu terbaca. Tolak hanya jika tidak ada wajah, wajah tertutup masker/gelap total, atau tidak ada kartu identitas yang dipegang.'
                    : `Analisis gambar berikut untuk verifikasi KYC tipe dokumen: ${docType}.`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl,
                  detail: 'high',
                },
              },
            ],
          },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('[API /api/verify-kyc] OpenAI API error:', openaiRes.status, errText);
      return NextResponse.json(
        {
          valid: false,
          reason: `Gagal menghubungi layanan AI Vision (status ${openaiRes.status}). Silakan coba lagi.`,
        },
        { status: 502 }
      );
    }

    const openaiData = await openaiRes.json();
    const rawContent: string | undefined = openaiData?.choices?.[0]?.message?.content;

    if (!rawContent) {
      return NextResponse.json(
        {
          valid: false,
          reason: 'Respons AI Vision kosong. Silakan unggah ulang gambar.',
        },
        { status: 502 }
      );
    }

    const parsed = JSON.parse(rawContent) as Partial<VerifyKycResponse>;
    const valid = parsed.valid === true;
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : valid
          ? 'Dokumen terbaca jelas dan valid.'
          : 'Dokumen tidak memenuhi kriteria verifikasi. Silakan unggah ulang foto yang jelas.';

    const extractedData: ExtractedKycData | undefined =
      parsed.extractedData && typeof parsed.extractedData === 'object'
        ? {
            ...(parsed.extractedData.nama ? { nama: String(parsed.extractedData.nama).trim() } : {}),
            ...(parsed.extractedData.nomor_id
              ? { nomor_id: String(parsed.extractedData.nomor_id).trim() }
              : {}),
            ...(parsed.extractedData.negara
              ? { negara: String(parsed.extractedData.negara).trim() }
              : {}),
          }
        : undefined;

    const result: VerifyKycResponse = {
      valid,
      reason,
      ...(extractedData && Object.keys(extractedData).length > 0 ? { extractedData } : {}),
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error('[API /api/verify-kyc] Unexpected error:', error);
    return NextResponse.json(
      {
        valid: false,
        reason:
          error instanceof Error
            ? `Terjadi kesalahan saat memvalidasi dokumen: ${error.message}`
            : 'Terjadi kesalahan internal saat memvalidasi dokumen.',
      },
      { status: 500 }
    );
  }
}
