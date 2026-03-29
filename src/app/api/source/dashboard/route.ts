import { NextResponse } from 'next/server';
import { safeReadJSON, DATA_PATHS } from '@/lib/file-operations';

export async function GET() {
  try {
    // Safe read operation (no race conditions)
    const searchLog = await safeReadJSON<Record<string, unknown>[]>(DATA_PATHS.SEARCH_LOG, []);

    const total = searchLog.length;
    const satisfied = searchLog.filter((e) => e.satisfied === true).length;
    const unsatisfied = searchLog.filter((e) => e.status === 'unsatisfied').length;
    const pending = searchLog.filter((e) => e.status === 'pending_validation').length;
    const successRate = total > 0 ? Math.round((satisfied / total) * 100) : 0;

    const totalRefinements = searchLog.reduce((sum, e) => sum + ((e.refinements as number) || 0), 0);
    const avgRefinements = total > 0 ? (totalRefinements / total).toFixed(1) : '0';

    // Zone breakdown
    const zoneStats: Record<string, number> = {};
    for (const entry of searchLog) {
      const spec = entry.spec as Record<string, unknown>;
      const zone = (spec?.zone as string) || 'unknown';
      zoneStats[zone] = (zoneStats[zone] || 0) + 1;
    }

    // Type breakdown
    const typeStats: Record<string, number> = {};
    for (const entry of searchLog) {
      const spec = entry.spec as Record<string, unknown>;
      const type = (spec?.type as string) || 'unknown';
      typeStats[type] = (typeStats[type] || 0) + 1;
    }

    // All searches, newest first (no limit — frontend handles scroll)
    const recent = [...searchLog]
      .sort((a, b) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime())
      .map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        status: e.status,
        satisfied: e.satisfied,
        refinements: e.refinements,
        description: (e.spec as Record<string, unknown>)?.description,
        zone: (e.spec as Record<string, unknown>)?.zone,
        type: (e.spec as Record<string, unknown>)?.type,
      }));

    return NextResponse.json({
      stats: { total, satisfied, unsatisfied, pending, successRate, avgRefinements },
      zoneStats,
      typeStats,
      recent,
    });
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json(
      { error: 'Eroare la încărcarea datelor: ' + (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
