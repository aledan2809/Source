import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { checkRateLimit } from '@/lib/validation';

async function retryWriteFile(filePath: string, data: Buffer, maxAttempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await writeFile(filePath, data);
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      const delay = Math.min(100 * Math.pow(2, attempt - 1), 1000);
      console.warn(`[Upload] Write attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_FILES_PER_REQUEST = 10;
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.gif', '.dwg', '.dxf'];

export async function POST(request: NextRequest) {
  try {
    // Rate limiting for uploads
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!checkRateLimit(ip, 20, 60000)) { // Max 20 uploads per minute
      return NextResponse.json(
        { error: 'Prea multe uploads. Încearcă din nou în câteva minute.' },
        { status: 429 }
      );
    }
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const sessionId = (formData.get('sessionId') as string) || randomUUID();

    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: 'Nu au fost trimise fișiere' },
        { status: 400 }
      );
    }

    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { error: `Maximum ${MAX_FILES_PER_REQUEST} fișiere per request` },
        { status: 400 }
      );
    }

    // Validate each file
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `Fișierul "${file.name}" este prea mare. Maximum ${MAX_FILE_SIZE / 1024 / 1024}MB.` },
          { status: 400 }
        );
      }

      const extension = path.extname(file.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        return NextResponse.json(
          { error: `Extensia "${extension}" nu este permisă pentru fișierul "${file.name}".` },
          { status: 400 }
        );
      }
    }

    // Store uploads OUTSIDE public/ — served via /api/uploads/[...path] with auth
    const uploadDir = path.join(process.cwd(), 'uploads', sessionId);
    try {
      await mkdir(uploadDir, { recursive: true });
    } catch (mkdirErr) {
      console.error('[Upload] Failed to create upload directory:', mkdirErr);
      return NextResponse.json(
        { error: 'Nu s-a putut crea directorul de upload' },
        { status: 500 }
      );
    }

    const paths: string[] = [];

    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadDir, safeName);

      try {
        await retryWriteFile(filePath, buffer);
        paths.push(`/api/uploads/${sessionId}/${safeName}`);
      } catch (writeErr) {
        console.error(`[Upload] Failed to write file "${safeName}" after retries:`, writeErr);
        // Continue with remaining files instead of aborting entire upload
      }
    }

    if (paths.length === 0) {
      return NextResponse.json(
        { error: 'Nu s-a putut salva niciun fișier' },
        { status: 500 }
      );
    }

    return NextResponse.json({ paths, sessionId });
  } catch (error) {
    console.error('Upload API error:', error);
    return NextResponse.json(
      { error: 'A apărut o eroare la încărcarea fișierelor' },
      { status: 500 }
    );
  }
}
