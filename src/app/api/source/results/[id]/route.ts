import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Sanitize id to prevent path traversal
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId || safeId !== id) {
      return NextResponse.json({ error: 'ID invalid' }, { status: 400 });
    }

    const filePath = path.join(process.cwd(), 'src', 'data', 'results', `${safeId}.json`);

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (readErr) {
      console.error(`[Results] Failed to read result file for ${safeId}:`, readErr);
      return NextResponse.json({ error: 'Rezultatul nu a fost găsit' }, { status: 404 });
    }

    const data = JSON.parse(content);

    // Auto-expire stuck "processing" entries after 3 minutes
    if (data.status === 'processing') {
      const refTime = data.updatedAt || data.createdAt;
      if (refTime) {
        const ageMs = Date.now() - new Date(refTime).getTime();
        if (ageMs > 3 * 60 * 1000) {
          data.status = 'error';
          data.error = 'Procesarea a expirat (timeout 3 min). Încearcă din nou.';
        }
      }
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Results API error:', error);
    return NextResponse.json(
      { error: 'Rezultatul nu a fost găsit' },
      { status: 404 }
    );
  }
}
