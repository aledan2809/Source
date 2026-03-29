'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface DashboardData {
  stats: {
    total: number;
    satisfied: number;
    unsatisfied: number;
    pending: number;
    successRate: number;
    avgRefinements: string;
  };
  zoneStats: Record<string, number>;
  typeStats: Record<string, number>;
  recent: Array<{
    id: string;
    createdAt: string;
    status: string;
    satisfied: boolean;
    refinements: number;
    description: string;
    zone: string;
    type: string;
  }>;
}

type FilterType = 'all' | 'satisfied' | 'unsatisfied' | 'pending';

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>('all');

  useEffect(() => {
    fetch('/api/source/dashboard')
      .then((r) => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const statusBadge = (status: string, satisfied: boolean) => {
    if (satisfied) return <span className="px-2 py-0.5 bg-green-700/40 text-green-300 rounded-full text-xs">Satisfăcut</span>;
    if (status === 'unsatisfied') return <span className="px-2 py-0.5 bg-red-700/40 text-red-300 rounded-full text-xs">Nesatisfăcut</span>;
    return <span className="px-2 py-0.5 bg-yellow-700/40 text-yellow-300 rounded-full text-xs">În așteptare</span>;
  };

  const zoneLabel = (z: string) =>
    z === 'local' ? 'Local' : z === 'regional' ? 'Regional' : z === 'global' ? 'Global' : z;

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="w-10 h-10 bg-gradient-to-br from-orange-500 to-red-600 rounded-xl flex items-center justify-center font-bold text-xl hover:opacity-90 transition"
            >
              S
            </button>
            <div>
              <h1 className="text-xl font-bold text-orange-500">Dashboard</h1>
              <p className="text-gray-400 text-xs">Istoricul căutărilor</p>
            </div>
          </div>
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-400 hover:to-red-500 rounded-lg text-sm font-medium transition"
          >
            + Căutare nouă
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-10 h-10 border-4 border-orange-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !data || data.stats.total === 0 ? (
          <div className="text-center py-24">
            <p className="text-gray-500 text-lg mb-4">Nicio căutare încă</p>
            <button
              onClick={() => router.push('/')}
              className="px-6 py-3 bg-orange-500 hover:bg-orange-400 rounded-xl font-medium transition"
            >
              Începe prima căutare
            </button>
          </div>
        ) : (
          <>
            {/* Stats grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
              {[
                { label: 'Total căutări', value: data.stats.total, color: 'text-white' },
                { label: 'Satisfăcute', value: data.stats.satisfied, color: 'text-green-400' },
                { label: 'Nesatisfăcute', value: data.stats.unsatisfied, color: 'text-red-400' },
                { label: 'În așteptare', value: data.stats.pending, color: 'text-yellow-400' },
                { label: 'Rată succes', value: `${data.stats.successRate}%`, color: 'text-orange-400' },
                { label: 'Rafinări/căutare', value: data.stats.avgRefinements, color: 'text-blue-400' },
              ].map((stat) => (
                <div key={stat.label} className="bg-gray-900 rounded-xl border border-gray-800 p-4 text-center">
                  <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
                  <div className="text-gray-400 text-xs mt-1">{stat.label}</div>
                </div>
              ))}
            </div>

            {/* Breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                <h3 className="text-white font-semibold mb-4">Pe zonă</h3>
                <div className="space-y-3">
                  {Object.entries(data.zoneStats).map(([zone, count]) => (
                    <div key={zone} className="flex items-center gap-3">
                      <span className="text-gray-400 text-sm w-20">{zoneLabel(zone)}</span>
                      <div className="flex-1 bg-gray-800 rounded-full h-2">
                        <div
                          className="bg-orange-500 h-2 rounded-full"
                          style={{ width: `${Math.round((count / data.stats.total) * 100)}%` }}
                        />
                      </div>
                      <span className="text-gray-300 text-sm w-6 text-right">{count}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                <h3 className="text-white font-semibold mb-4">Pe tip</h3>
                <div className="space-y-3">
                  {Object.entries(data.typeStats).map(([type, count]) => (
                    <div key={type} className="flex items-center gap-3">
                      <span className="text-gray-400 text-sm w-24">
                        {type === 'cumparare' ? 'Cumpărare' : type === 'inchiriere' ? 'Închiriere' : type}
                      </span>
                      <div className="flex-1 bg-gray-800 rounded-full h-2">
                        <div
                          className="bg-red-500 h-2 rounded-full"
                          style={{ width: `${Math.round((count / data.stats.total) * 100)}%` }}
                        />
                      </div>
                      <span className="text-gray-300 text-sm w-6 text-right">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* All searches — filterable + scrollable */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-semibold">Căutări</h3>
                <div className="flex gap-1.5">
                  {([
                    { id: 'all', label: 'Toate', count: data.recent.length },
                    { id: 'satisfied', label: '👍 Bune', count: data.recent.filter(i => i.satisfied).length },
                    { id: 'unsatisfied', label: '👎 Slabe', count: data.recent.filter(i => i.status === 'unsatisfied').length },
                    { id: 'pending', label: 'Neevaluate', count: data.recent.filter(i => !i.satisfied && i.status !== 'unsatisfied').length },
                  ] as { id: FilterType; label: string; count: number }[]).map(f => (
                    <button
                      key={f.id}
                      onClick={() => setFilter(f.id)}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                        filter === f.id
                          ? 'bg-orange-600 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                      }`}
                    >
                      {f.label} <span className="opacity-60">{f.count}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
                {data.recent.filter(item => {
                  if (filter === 'all') return true;
                  if (filter === 'satisfied') return item.satisfied;
                  if (filter === 'unsatisfied') return item.status === 'unsatisfied';
                  if (filter === 'pending') return !item.satisfied && item.status !== 'unsatisfied';
                  return true;
                }).map((item) => (
                  <div
                    key={item.id}
                    onClick={() => router.push(`/results/${item.id}`)}
                    className="flex items-center gap-4 p-3 bg-gray-800 hover:bg-gray-700 rounded-lg cursor-pointer transition border border-transparent hover:border-gray-600"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm truncate">{item.description}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-gray-500 text-xs">
                          {new Date(item.createdAt).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="text-gray-600 text-xs">·</span>
                        <span className="text-gray-500 text-xs">{zoneLabel(item.zone)}</span>
                        {item.refinements > 0 && (
                          <>
                            <span className="text-gray-600 text-xs">·</span>
                            <span className="text-orange-400 text-xs">{item.refinements} rafinări</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex-shrink-0">
                      {statusBadge(item.status, item.satisfied)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
