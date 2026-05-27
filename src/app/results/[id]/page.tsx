'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';

interface Supplier {
  name: string;
  website: string;
  productUrl?: string;
  email: string;
  phone: string;
  country: string;
  priceMin?: number;
  priceMax?: number;
  priceCurrency?: string;
  priceSource?: 'scraped' | 'unavailable';
  notes: string;
  urlVerified?: boolean;
}

interface Email {
  to: string;
  subject: string;
  body: string;
}

interface GuardrailsIssue {
  supplier_index: number;
  supplier_name: string;
  flags: Array<{ type: string; message: string }>;
}

interface SourcingResult {
  id: string;
  createdAt: string;
  updatedAt?: string;
  satisfied: boolean;
  userFeedback?: string;
  status: string;
  refinements: number;
  guardrailsWarnings?: GuardrailsIssue[];
  spec: {
    description: string;
    type: string;
    condition?: string;
    zone: string;
    zoneLocation?: string;
    quantity: number;
    unit: string;
    deadline: string;
    budgetMin?: number;
    budgetMax?: number;
    currency: string;
    filePaths?: string[];
    clarifications?: Array<{ question: string; answer: string }>;
    summary?: string;
  };
  result: {
    summary: string;
    suppliers: Supplier[];
    rfq: string;
    emails: Email[];
    brief: string;
  };
  pipeline?: {
    qualityScore: number;
    qualityDecision: 'pass' | 'flag' | 'fail';
    qualityBreakdown: Record<string, number>;
    stages: Array<{ stage: string; event: string; timestamp: string }>;
    guardrailsEngine: string;
    supplierCount: number;
    verifiedCount: number;
    pricesScraped: number;
  };
}

type TabType = 'furnizori' | 'rfq' | 'emailuri' | 'brief';

export default function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const router = useRouter();
  const [data, setData] = useState<SourcingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('furnizori');
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  // Feedback / iterative state
  const [showRequest, setShowRequest] = useState(false);
  const [showFeedbackPanel, setShowFeedbackPanel] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [refining, setRefining] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Result-level feedback state
  const [resultRating, setResultRating] = useState<'good' | 'bad' | null>(null);

  // Per-card feedback state (product = result relevance, vendor = company reputation)
  type FeedbackKey = `${'product' | 'vendor'}-${number}`;
  const [cardRatings, setCardRatings] = useState<Record<FeedbackKey, 'good' | 'bad'>>({});
  const [cardComments, setCardComments] = useState<Record<FeedbackKey, string>>({});
  const [cardCommentOpen, setCardCommentOpen] = useState<Record<FeedbackKey, boolean>>({});
  const [cardFeedbackSent, setCardFeedbackSent] = useState<Record<FeedbackKey, boolean>>({});

  // Timer — calculated from data.updatedAt (when processing actually started on server)
  const updatedAt = data?.updatedAt;
  useEffect(() => {
    if (!polling || !data) { setElapsedSeconds(0); return; }
    const serverStart = updatedAt ? new Date(updatedAt).getTime() : Date.now();
    const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - serverStart) / 1000)));
    tick(); // immediate
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, updatedAt]);

  useEffect(() => {
    fetchResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedParams.id]);

  async function fetchResults() {
    try {
      const res = await fetch(`/api/source/results/${resolvedParams.id}`);
      if (!res.ok) {
        setError('Rezultatul nu a fost găsit');
        setLoading(false);
        return;
      }
      const result = await res.json();
      if (result.status === 'processing') {
        setData(result);
        setLoading(false);
        setPolling(true);
        pollForResult();
        return;
      }
      if (result.status === 'error') {
        setError(result.error || 'Eroare la generare');
        setLoading(false);
        return;
      }
      setData(result);
      setPolling(false);
    } catch {
      setError('Eroare la încărcarea rezultatelor');
    } finally {
      setLoading(false);
    }
  }

  async function pollForResult() {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/source/results/${resolvedParams.id}`);
        if (!res.ok) return;
        const result = await res.json();
        if (result.status === 'processing') return; // still running
        clearInterval(interval);
        setPolling(false);
        if (result.status === 'error') {
          setError(result.error || 'Eroare la generare');
        } else {
          setData(result);
        }
      } catch { /* retry next tick */ }
    }, 3000);
    // Safety timeout after 3 minutes
    setTimeout(() => clearInterval(interval), 3 * 60 * 1000);
  }

  async function copyToClipboard(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  }

  function downloadAsFile(content: string, filename: string) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSatisfied() {
    if (!data) return;
    setSubmittingFeedback(true);
    try {
      await fetch('/api/source/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchId: data.id,
          satisfied: true,
          feedback: `Furnizori găsiți cu succes pentru: ${data.spec.description.slice(0, 100)}`,
        }),
      });
      setData({ ...data, satisfied: true, status: 'satisfied' });
      setShowFeedbackPanel(false);
    } finally {
      setSubmittingFeedback(false);
    }
  }

  async function handleRefine() {
    if (!data) return;
    setRefining(true);
    setError(null);

    try {
      // Save negative feedback first
      await fetch('/api/source/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchId: data.id,
          satisfied: false,
          feedback: feedbackText,
        }),
      });

      // Generate refined result (async — navigate immediately)
      const genRes = await fetch('/api/source/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data.spec,
          searchId: data.id,
          previousResult: data.result,
          refinementFeedback: feedbackText,
        }),
      });

      const genData = await genRes.json();

      if (!genRes.ok) {
        setError(genData.error || 'Eroare la rafinare');
        return;
      }

      // Same ID = same page — reset state and start polling instead of navigating
      if (genData.id === data.id) {
        setData({ ...data, status: 'processing', result: data.result });
        setShowFeedbackPanel(false);
        setFeedbackText('');
        setPolling(true);
        pollForResult();
      } else {
        router.push(`/results/${genData.id}`);
      }
    } catch {
      setError('Eroare la comunicarea cu serverul');
    } finally {
      setRefining(false);
    }
  }

  async function handleMoreResults() {
    if (!data) return;
    setRefining(true);
    setError(null);
    try {
      const genRes = await fetch('/api/source/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data.spec,
          // New ID — creates a separate result, doesn't overwrite
          searchId: undefined,
        }),
      });
      const genData = await genRes.json();
      if (!genRes.ok) {
        setError(genData.error || 'Eroare la generare');
        return;
      }
      router.push(`/results/${genData.id}`);
    } catch {
      setError('Eroare la comunicarea cu serverul');
    } finally {
      setRefining(false);
    }
  }

  async function handleResultFeedback() {
    if (!data || !resultRating) return;
    setSubmittingFeedback(true);
    try {
      const satisfied = resultRating === 'good';
      await fetch('/api/source/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchId: data.id,
          satisfied,
          feedback: feedbackText || (satisfied ? 'Rezultat bun' : 'Rezultat slab'),
        }),
      });
      setData({
        ...data,
        satisfied,
        status: satisfied ? 'satisfied' : 'unsatisfied',
        userFeedback: feedbackText || undefined,
      } as SourcingResult);
      setShowFeedbackPanel(false);
      setFeedbackText('');
    } finally {
      setSubmittingFeedback(false);
    }
  }

  async function submitCardFeedback(type: 'product' | 'vendor', index: number, rating: 'good' | 'bad') {
    if (!data) return;
    const key: FeedbackKey = `${type}-${index}`;
    setCardRatings(prev => ({ ...prev, [key]: rating }));

    // 👍 sends immediately, 👎 opens comment first
    if (rating === 'good') {
      try {
        await fetch('/api/source/supplier-feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            searchId: data.id,
            supplierIndex: index,
            rating,
            feedbackType: type,
          }),
        });
        setCardFeedbackSent(prev => ({ ...prev, [key]: true }));
      } catch { /* silent */ }
    } else {
      // Open comment input for negative feedback
      setCardCommentOpen(prev => ({ ...prev, [key]: true }));
    }
  }

  async function submitCardComment(type: 'product' | 'vendor', index: number) {
    if (!data) return;
    const key: FeedbackKey = `${type}-${index}`;
    const rating = cardRatings[key];
    if (!rating) return;
    try {
      await fetch('/api/source/supplier-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchId: data.id,
          supplierIndex: index,
          rating,
          comment: cardComments[key] || undefined,
          feedbackType: type,
        }),
      });
      setCardFeedbackSent(prev => ({ ...prev, [key]: true }));
      setCardCommentOpen(prev => ({ ...prev, [key]: false }));
    } catch { /* silent */ }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Se încarcă rezultatele...</p>
        </div>
      </div>
    );
  }

  // Processing state — show live spinner while Claude generates in background
  if (polling && data?.status === 'processing') {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-40">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button onClick={() => router.push('/')} className="w-10 h-10 bg-gradient-to-br from-orange-500 to-red-600 rounded-xl flex items-center justify-center font-bold text-xl hover:opacity-90 transition">S</button>
              <div>
                <h1 className="text-xl font-bold text-orange-500">Se generează...</h1>
                <p className="text-gray-400 text-xs">Căutare în curs de procesare</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => router.push('/dashboard')} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition">Dashboard</button>
              <button onClick={() => router.push('/')} className="px-4 py-2 bg-gradient-to-r from-orange-500 to-red-600 rounded-lg text-sm font-medium transition">+ Căutare nouă</button>
            </div>
          </div>
        </header>
        <main className="max-w-4xl mx-auto px-6 py-16 text-center">
          <div className="w-20 h-20 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-semibold text-white mb-3">AI caută furnizori...</h2>

          {/* Elapsed timer */}
          <p className="text-orange-400 font-mono text-lg mb-2">
            {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}
          </p>

          {/* Progress bar — estimated ~45s total */}
          {(() => {
            const estimatedTotal = 45; // seconds
            // Slow logarithmic curve: fast at start, slows near end, never reaches 100%
            const rawProgress = Math.log(1 + elapsedSeconds) / Math.log(1 + estimatedTotal * 1.5) * 100;
            const progress = Math.min(95, Math.round(rawProgress));
            const stage = elapsedSeconds < 8 ? 'Generare furnizori cu AI...'
              : elapsedSeconds < 20 ? 'Crawl site-uri furnizori...'
              : elapsedSeconds < 35 ? 'Extragere prețuri reale...'
              : elapsedSeconds < 45 ? 'Validare guardrails...'
              : 'Finalizare...';
            return (
              <div className="max-w-md mx-auto mb-4">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>{stage}</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-2">
                  <div
                    className="bg-gradient-to-r from-orange-500 to-red-500 h-2 rounded-full transition-all duration-1000"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            );
          })()}

          <p className="text-gray-400 text-sm mb-1">Procesul rulează în background. Poți lansa o nouă căutare în paralel.</p>
          <p className="text-gray-500 text-xs">Pagina se actualizează automat la fiecare 3 secunde.</p>

          {elapsedSeconds > 120 && (
            <div className="mt-4 px-4 py-2 bg-yellow-900/20 border border-yellow-700/30 rounded-lg text-yellow-400 text-sm max-w-md mx-auto">
              Durează mai mult decât de obicei. Dacă nu se termină în 5 minute, încearcă o căutare nouă.
            </div>
          )}

          <div className="mt-8 bg-gray-900 rounded-xl border border-gray-800 p-5 text-left max-w-xl mx-auto">
            <p className="text-xs text-gray-500 mb-2">Cerere procesată:</p>
            <p className="text-gray-300 text-sm">{(data as {spec?: {description?: string}}).spec?.description}</p>
          </div>
        </main>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error || 'Rezultatul nu a fost găsit'}</p>
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 bg-orange-500 hover:bg-orange-400 rounded-lg transition"
          >
            Înapoi la formular
          </button>
        </div>
      </div>
    );
  }

  const tabs: { id: TabType; label: string }[] = [
    { id: 'furnizori', label: 'Furnizori' },
    { id: 'rfq', label: 'RFQ' },
    { id: 'emailuri', label: 'Email-uri' },
    { id: 'brief', label: 'Brief' },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/')}
                className="w-10 h-10 bg-gradient-to-br from-orange-500 to-red-600 rounded-xl flex items-center justify-center font-bold text-xl hover:opacity-90 transition"
              >
                S
              </button>
              <div>
                <h1 className="text-xl font-bold text-orange-500">Rezultate Sourcing</h1>
                <p className="text-gray-400 text-xs">
                  <span className="text-gray-500 font-mono">#{data.id.substring(0, 8)}</span>
                  {' · '}
                  {new Date(data.createdAt).toLocaleDateString('ro-RO', {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {data.refinements > 0 && (
                    <span className="ml-2 text-orange-400">• {data.refinements} rafinări</span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => router.push('/dashboard')}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition text-sm"
              >
                Dashboard
              </button>
              <button
                onClick={() => router.push('/')}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition text-sm"
              >
                + Căutare nouă
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 mb-6">
          <h2 className="text-lg font-semibold text-white mb-2">Rezumat</h2>
          <p className="text-gray-300">{data.result.summary}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="px-3 py-1 bg-gray-800 rounded-full text-sm text-gray-400">
              {data.spec.type === 'cumparare' ? 'Cumpărare' : 'Închiriere'}
            </span>
            <span className="px-3 py-1 bg-gray-800 rounded-full text-sm text-gray-400">
              {data.spec.quantity} {data.spec.unit}
            </span>
            <span className="px-3 py-1 bg-gray-800 rounded-full text-sm text-gray-400">
              {data.spec.zone === 'local' ? 'Local' : data.spec.zone === 'regional' ? 'Regional' : 'Global'}
              {data.spec.zoneLocation ? ` — ${data.spec.zoneLocation}` : ''}
            </span>
            {data.spec.budgetMin || data.spec.budgetMax ? (
              <span className="px-3 py-1 bg-gray-800 rounded-full text-sm text-gray-400">
                {data.spec.budgetMin || '?'} - {data.spec.budgetMax || '?'} {data.spec.currency}
              </span>
            ) : null}
          </div>
        </div>

        {/* Saved request */}
        <div className="bg-gray-900 rounded-2xl border border-gray-800 mb-6 overflow-hidden">
          <button
            onClick={() => setShowRequest(!showRequest)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-800/50 transition text-left"
          >
            <span className="text-sm font-medium text-gray-300">Cererea ta salvată</span>
            <span className="text-gray-500 text-xs">{showRequest ? '▲ Ascunde' : '▼ Arată'}</span>
          </button>
          {showRequest && (
            <div className="px-5 pb-5 border-t border-gray-800 pt-4 space-y-4">
              <div>
                <p className="text-xs text-gray-500 mb-1">Descriere</p>
                <p className="text-gray-200 text-sm">{data.spec.description}</p>
              </div>
              <div className="flex flex-wrap gap-3 text-sm">
                <div>
                  <span className="text-gray-500 text-xs">Tip: </span>
                  <span className="text-gray-300">{data.spec.type === 'cumparare' ? 'Cumpărare' : 'Închiriere'}</span>
                </div>
                {data.spec.condition && (
                  <div>
                    <span className="text-gray-500 text-xs">Condiție: </span>
                    <span className="text-gray-300">{data.spec.condition === 'nou' ? 'Nou' : data.spec.condition === 'second-hand' ? 'Second-hand' : 'Indiferent'}</span>
                  </div>
                )}
                <div>
                  <span className="text-gray-500 text-xs">Zonă: </span>
                  <span className="text-gray-300">
                    {data.spec.zone === 'local' ? 'Local' : data.spec.zone === 'regional' ? 'Regional' : 'Global'}
                    {data.spec.zoneLocation ? ` — ${data.spec.zoneLocation}` : ''}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs">Cantitate: </span>
                  <span className="text-gray-300">{data.spec.quantity} {data.spec.unit}</span>
                </div>
                <div>
                  <span className="text-gray-500 text-xs">Deadline: </span>
                  <span className="text-gray-300">{data.spec.deadline}</span>
                </div>
                {(data.spec.budgetMin || data.spec.budgetMax) && (
                  <div>
                    <span className="text-gray-500 text-xs">Buget: </span>
                    <span className="text-gray-300">{data.spec.budgetMin || '?'} – {data.spec.budgetMax || '?'} {data.spec.currency}</span>
                  </div>
                )}
              </div>
              {data.spec.clarifications && data.spec.clarifications.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-2">Clarificări AI</p>
                  <div className="space-y-3">
                    {data.spec.clarifications.map((c, i) => (
                      <div key={i} className="bg-gray-800 rounded-lg p-3">
                        <p className="text-xs text-orange-400 mb-1">Î: {c.question}</p>
                        <p className="text-sm text-gray-200">R: {c.answer || '—'}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Result feedback panel — thumbs up/down + comment → feeds AI learning */}
        <div className="bg-gray-900 rounded-2xl border border-gray-800 p-5 mb-6">
          {data.satisfied ? (
            <div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-green-500">👍 Marcat ca util</span>
                  {data.userFeedback && <span className="text-gray-500">&mdash; &ldquo;{data.userFeedback}&rdquo;</span>}
                </div>
                <span className="text-xs text-gray-600">
                  <button onClick={() => router.push('/dashboard')} className="text-orange-400 hover:text-orange-300 underline">Dashboard</button>
                </span>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-800 flex items-center justify-between">
                <span className="text-gray-400 text-sm">Vrei mai multe rezultate pentru aceeași căutare?</span>
                <button
                  onClick={handleMoreResults}
                  disabled={refining}
                  className="px-4 py-2 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-400 hover:to-red-500 rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {refining ? 'Se generează...' : 'Generează alte rezultate →'}
                </button>
              </div>
              {error && <div className="mt-2 text-red-400 text-sm">{error}</div>}
            </div>
          ) : data.status === 'unsatisfied' ? (
            <div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-red-400">👎 Marcat ca nesatisfăcător</span>
                  {data.userFeedback && <span className="text-gray-500">&mdash; &ldquo;{data.userFeedback}&rdquo;</span>}
                </div>
                <span className="text-xs text-gray-600">
                  <button onClick={() => router.push('/dashboard')} className="text-orange-400 hover:text-orange-300 underline">Dashboard</button>
                </span>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-800 flex items-center justify-between">
                <span className="text-gray-400 text-sm">Vrei alte rezultate?</span>
                <button
                  onClick={handleMoreResults}
                  disabled={refining}
                  className="px-4 py-2 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-400 hover:to-red-500 rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {refining ? 'Se generează...' : 'Generează alte rezultate →'}
                </button>
              </div>
              {error && <div className="mt-2 text-red-400 text-sm">{error}</div>}
            </div>
          ) : !showFeedbackPanel ? (
            <div className="flex items-center justify-between">
              <p className="text-gray-300 text-sm">Cum evaluezi rezultatele?</p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    handleSatisfied();
                  }}
                  disabled={submittingFeedback}
                  className="px-4 py-2 bg-gray-800 hover:bg-green-900/50 hover:text-green-400 border border-gray-700 hover:border-green-700/50 rounded-lg text-sm font-medium transition disabled:opacity-50 flex items-center gap-2"
                >
                  <span className="text-lg">👍</span> Bun
                </button>
                <button
                  onClick={() => setShowFeedbackPanel(true)}
                  className="px-4 py-2 bg-gray-800 hover:bg-red-900/50 hover:text-red-400 border border-gray-700 hover:border-red-700/50 rounded-lg text-sm font-medium transition flex items-center gap-2"
                >
                  <span className="text-lg">👎</span> Slab
                </button>
                <button
                  onClick={() => setShowFeedbackPanel(true)}
                  className="px-3 py-2 text-gray-500 hover:text-gray-300 text-xs transition"
                >
                  + comentariu
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-3 mb-3">
                <h3 className="text-white font-medium">Feedback rezultat</h3>
                <div className="flex gap-1">
                  <button
                    onClick={() => setResultRating('good')}
                    className={`px-3 py-1 rounded text-sm transition ${
                      resultRating === 'good'
                        ? 'bg-green-700 text-green-100'
                        : 'bg-gray-800 hover:bg-green-900/50 text-gray-400'
                    }`}
                  >
                    👍
                  </button>
                  <button
                    onClick={() => setResultRating('bad')}
                    className={`px-3 py-1 rounded text-sm transition ${
                      resultRating === 'bad'
                        ? 'bg-red-700 text-red-100'
                        : 'bg-gray-800 hover:bg-red-900/50 text-gray-400'
                    }`}
                  >
                    👎
                  </button>
                </div>
              </div>
              <textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Ce a fost bun? Ce lipsea? Ce furnizori ai fi vrut? Ex: vreau magazin online cu prețuri, nu distribuitori en-gros..."
                rows={3}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-400 focus:border-orange-500 focus:outline-none resize-none text-sm"
              />
              {error && (
                <div className="mt-2 text-red-400 text-sm">{error}</div>
              )}
              <div className="mt-3 flex gap-3">
                <button
                  onClick={() => { setShowFeedbackPanel(false); setFeedbackText(''); setError(null); setResultRating(null); }}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition"
                >
                  Anulează
                </button>
                <button
                  onClick={handleResultFeedback}
                  disabled={submittingFeedback || !resultRating}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition disabled:opacity-50"
                >
                  {submittingFeedback ? 'Se salvează...' : 'Salvează feedback'}
                </button>
                {resultRating === 'bad' && (
                  <button
                    onClick={handleRefine}
                    disabled={refining}
                    className="flex-1 py-2 px-4 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-400 hover:to-red-500 rounded-lg text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {refining ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Se regenerează...
                      </span>
                    ) : 'Regenerează cu feedback →'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* NeMo Guardrails warnings */}
        {data.guardrailsWarnings && data.guardrailsWarnings.length > 0 && (
          <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-4 mb-6">
            <p className="text-yellow-400 font-medium text-sm mb-2">
              ⚠ {data.guardrailsWarnings.length} furnizor(i) filtrat(i) automat de Guardrails
            </p>
            <div className="space-y-1">
              {data.guardrailsWarnings.map((w, i) => (
                <div key={i} className="text-xs text-yellow-300/70">
                  <span className="font-medium">{w.supplier_name || `Furnizor #${w.supplier_index + 1}`}:</span>{' '}
                  {w.flags.map(f => f.message).join('; ')}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pipeline Quality Score */}
        {data.pipeline && (
          <div className={`rounded-xl p-4 mb-6 flex items-center justify-between ${
            data.pipeline.qualityDecision === 'pass'
              ? 'bg-green-900/15 border border-green-700/30'
              : data.pipeline.qualityDecision === 'flag'
              ? 'bg-orange-900/15 border border-orange-700/30'
              : 'bg-red-900/15 border border-red-700/30'
          }`}>
            <div>
              <div className="flex items-center gap-3 mb-1">
                <span className={`text-2xl font-bold ${
                  data.pipeline.qualityDecision === 'pass' ? 'text-green-400' :
                  data.pipeline.qualityDecision === 'flag' ? 'text-orange-400' : 'text-red-400'
                }`}>
                  {data.pipeline.qualityScore}/100
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                  data.pipeline.qualityDecision === 'pass' ? 'bg-green-800/40 text-green-400' :
                  data.pipeline.qualityDecision === 'flag' ? 'bg-orange-800/40 text-orange-400' : 'bg-red-800/40 text-red-400'
                }`}>
                  {data.pipeline.qualityDecision === 'pass' ? 'QUALITY PASS' :
                   data.pipeline.qualityDecision === 'flag' ? 'NEEDS REVIEW' : 'LOW QUALITY'}
                </span>
              </div>
              <div className="flex gap-3 text-xs text-gray-500">
                <span>{data.pipeline.supplierCount} furnizori</span>
                <span>{data.pipeline.verifiedCount} verificați</span>
                <span>{data.pipeline.pricesScraped} prețuri reale</span>
                <span>Engine: {data.pipeline.guardrailsEngine}</span>
              </div>
            </div>
            {data.pipeline.qualityDecision === 'flag' && !data.satisfied && (
              <button
                onClick={() => setShowFeedbackPanel(true)}
                className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition"
              >
                Regenerează
              </button>
            )}
          </div>
        )}

        <div className="flex gap-2 mb-6 border-b border-gray-800 pb-2 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-lg font-medium transition whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
              }`}
            >
              {tab.label}
              {tab.id === 'furnizori' && (
                <span className="ml-2 px-2 py-0.5 bg-white/20 rounded-full text-xs">
                  {data.result.suppliers.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {activeTab === 'furnizori' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="col-span-full mb-2 px-4 py-3 bg-gray-800/50 border border-gray-700/30 rounded-lg text-xs text-gray-400">
              Prețurile verzi sunt extrase direct de pe site-ul furnizorului. Unde prețul nu a putut fi citit automat, contactează furnizorul direct. Link-urile de produse sunt verificate automat, dar disponibilitatea se poate schimba.
            </div>
            {!data.result.suppliers[0]?.priceMin && !data.result.suppliers[0]?.productUrl && (
              <div className="col-span-full mb-2 px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-400">
                Această căutare a fost generată înainte de actualizare. <button onClick={() => setShowFeedbackPanel(true)} className="text-orange-400 hover:text-orange-300 underline">Regenerează</button> pentru a vedea prețuri și link-uri directe la produse.
              </div>
            )}
            {data.result.suppliers.map((supplier, index) => (
              <div
                key={index}
                className="bg-gray-900 rounded-xl border border-gray-800 p-5 hover:border-gray-700 transition"
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">{supplier.name}</h3>
                    <p className="text-gray-400 text-sm">{supplier.country}</p>
                  </div>
                  {supplier.urlVerified && (
                    <span className="text-xs px-2 py-0.5 bg-green-800/40 text-green-400 rounded-full border border-green-700/40 flex-shrink-0">✓ verificat</span>
                  )}
                </div>

                {(supplier.priceMin || supplier.priceMax) && (
                  <div className={`mb-3 px-3 py-2 rounded-lg ${
                    supplier.priceSource === 'scraped'
                      ? 'bg-green-900/20 border border-green-700/30'
                      : 'bg-yellow-900/20 border border-yellow-700/30'
                  }`}>
                    <span className={`font-semibold text-sm ${
                      supplier.priceSource === 'scraped' ? 'text-green-400' : 'text-yellow-400'
                    }`}>
                      {supplier.priceMin && supplier.priceMax && supplier.priceMin === supplier.priceMax
                        ? `${supplier.priceMin.toLocaleString()} ${supplier.priceCurrency || 'RON'}`
                        : supplier.priceMin && supplier.priceMax
                        ? `${supplier.priceMin.toLocaleString()} – ${supplier.priceMax.toLocaleString()} ${supplier.priceCurrency || 'RON'}`
                        : supplier.priceMin
                        ? `de la ${supplier.priceMin.toLocaleString()} ${supplier.priceCurrency || 'RON'}`
                        : `până la ${supplier.priceMax!.toLocaleString()} ${supplier.priceCurrency || 'RON'}`}
                    </span>
                    {supplier.priceSource === 'scraped'
                      ? <span className="text-green-600 text-xs ml-2">preț real de pe site</span>
                      : <span className="text-yellow-600 text-xs ml-2">~ estimare, neverificat</span>
                    }
                  </div>
                )}

                <div className="space-y-2 text-sm">
                  {supplier.productUrl && supplier.productUrl !== supplier.website && (
                    <a
                      href={supplier.productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-green-400 hover:text-green-300 transition"
                    >
                      <span>🛒</span>
                      <span className="truncate text-xs">{supplier.productUrl}</span>
                    </a>
                  )}
                  {supplier.website && (
                    <a
                      href={supplier.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-orange-400 hover:text-orange-300 transition"
                    >
                      <span>🌐</span>
                      <span className="truncate">{supplier.website}</span>
                    </a>
                  )}
                  {!supplier.productUrl && !supplier.website && (
                    <div className="flex items-center gap-2 text-gray-500 text-xs italic">
                      <span>⚠</span>
                      <span>Nu s-a găsit un link valid — verifică manual furnizorul</span>
                    </div>
                  )}
                  {supplier.email && (
                    <div className="flex items-center gap-2 text-gray-300">
                      <span>📧</span>
                      <span>{supplier.email}</span>
                      <button
                        onClick={() => copyToClipboard(supplier.email, `email-${index}`)}
                        className={`ml-auto px-2 py-1 rounded text-xs transition ${
                          copiedText === `email-${index}`
                            ? 'bg-green-600 text-white'
                            : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                        }`}
                      >
                        {copiedText === `email-${index}` ? 'Copiat!' : 'Copiază'}
                      </button>
                    </div>
                  )}
                  {supplier.phone && (
                    <div className="flex items-center gap-2 text-gray-300">
                      <span>📞</span>
                      <span>{supplier.phone}</span>
                    </div>
                  )}
                </div>

                {supplier.notes && (
                  <p className="mt-3 text-sm text-gray-400 border-t border-gray-800 pt-3">
                    {supplier.notes}
                  </p>
                )}

                {/* Feedback section — 2 rows: Product + Vendor */}
                <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
                  {/* Row 1: Product feedback — is this result relevant? */}
                  {(() => {
                    const key: FeedbackKey = `product-${index}`;
                    return cardFeedbackSent[key] ? (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-gray-500 w-16">Produs:</span>
                        <span className={cardRatings[key] === 'good' ? 'text-green-500' : 'text-red-400'}>
                          {cardRatings[key] === 'good' ? '👍 Relevant' : '👎 Irelevant'}
                        </span>
                        {cardComments[key] && <span className="text-gray-600">— {cardComments[key]}</span>}
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500 w-16">Produs:</span>
                          <button onClick={() => submitCardFeedback('product', index, 'good')}
                            className={`px-2 py-0.5 rounded text-xs transition ${cardRatings[key] === 'good' ? 'bg-green-700 text-green-100' : 'bg-gray-800 hover:bg-green-900/50 text-gray-400 hover:text-green-400'}`}>
                            👍
                          </button>
                          <button onClick={() => submitCardFeedback('product', index, 'bad')}
                            className={`px-2 py-0.5 rounded text-xs transition ${cardRatings[key] === 'bad' ? 'bg-red-700 text-red-100' : 'bg-gray-800 hover:bg-red-900/50 text-gray-400 hover:text-red-400'}`}>
                            👎
                          </button>
                          <span className="text-[10px] text-gray-600 ml-1">rezultat relevant?</span>
                        </div>
                        {cardCommentOpen[key] && (
                          <div className="mt-1.5 flex gap-2 ml-16">
                            <input type="text"
                              placeholder="De ce nu e relevant? (produs greșit, preț prea mare, etc.)"
                              value={cardComments[key] || ''}
                              onChange={(e) => setCardComments(prev => ({ ...prev, [key]: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && submitCardComment('product', index)}
                              className="flex-1 px-2.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
                            />
                            <button onClick={() => submitCardComment('product', index)}
                              className="px-2.5 py-1 bg-orange-600 hover:bg-orange-500 rounded text-xs transition">
                              Trimite
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Row 2: Vendor feedback — how is this company? */}
                  {(() => {
                    const key: FeedbackKey = `vendor-${index}`;
                    return cardFeedbackSent[key] ? (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-gray-500 w-16">Furnizor:</span>
                        <span className={cardRatings[key] === 'good' ? 'text-green-500' : 'text-red-400'}>
                          {cardRatings[key] === 'good' ? '👍 Bun' : '👎 Slab'}
                        </span>
                        {cardComments[key] && <span className="text-gray-600">— {cardComments[key]}</span>}
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500 w-16">Furnizor:</span>
                          <button onClick={() => submitCardFeedback('vendor', index, 'good')}
                            className={`px-2 py-0.5 rounded text-xs transition ${cardRatings[key] === 'good' ? 'bg-green-700 text-green-100' : 'bg-gray-800 hover:bg-green-900/50 text-gray-400 hover:text-green-400'}`}>
                            👍
                          </button>
                          <button onClick={() => submitCardFeedback('vendor', index, 'bad')}
                            className={`px-2 py-0.5 rounded text-xs transition ${cardRatings[key] === 'bad' ? 'bg-red-700 text-red-100' : 'bg-gray-800 hover:bg-red-900/50 text-gray-400 hover:text-red-400'}`}>
                            👎
                          </button>
                          <span className="text-[10px] text-gray-600 ml-1">companie de încredere?</span>
                        </div>
                        {cardCommentOpen[key] && (
                          <div className="mt-1.5 flex gap-2 ml-16">
                            <input type="text"
                              placeholder="Review-uri proaste, nu livrează la timp, prețuri umflate, etc."
                              value={cardComments[key] || ''}
                              onChange={(e) => setCardComments(prev => ({ ...prev, [key]: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && submitCardComment('vendor', index)}
                              className="flex-1 px-2.5 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
                            />
                            <button onClick={() => submitCardComment('vendor', index)}
                              className="px-2.5 py-1 bg-orange-600 hover:bg-orange-500 rounded text-xs transition">
                              Trimite
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'rfq' && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Request for Quotation</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => copyToClipboard(data.result.rfq, 'rfq')}
                  className={`px-3 py-1.5 rounded-lg text-sm transition ${
                    copiedText === 'rfq'
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  }`}
                >
                  {copiedText === 'rfq' ? 'Copiat!' : 'Copiază'}
                </button>
                <button
                  onClick={() => downloadAsFile(data.result.rfq, 'RFQ.txt')}
                  className="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded-lg text-sm transition"
                >
                  Descarcă
                </button>
              </div>
            </div>
            <pre className="whitespace-pre-wrap text-gray-300 text-sm leading-relaxed font-sans">
              {data.result.rfq}
            </pre>
          </div>
        )}

        {activeTab === 'emailuri' && (
          <div className="space-y-4">
            {data.result.emails.map((email, index) => (
              <div
                key={index}
                className="bg-gray-900 rounded-xl border border-gray-800 p-6"
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="text-sm text-gray-400 mb-1">Către: {email.to}</div>
                    <div className="text-lg font-semibold text-white">{email.subject}</div>
                  </div>
                  <button
                    onClick={() => copyToClipboard(email.body, `email-body-${index}`)}
                    className={`px-3 py-1.5 rounded-lg text-sm transition ${
                      copiedText === `email-body-${index}`
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                    }`}
                  >
                    {copiedText === `email-body-${index}` ? 'Copiat!' : 'Copiază email'}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap text-gray-300 text-sm leading-relaxed font-sans border-t border-gray-800 pt-4">
                  {email.body}
                </pre>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'brief' && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Brief de Sourcing</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => copyToClipboard(data.result.brief, 'brief')}
                  className={`px-3 py-1.5 rounded-lg text-sm transition ${
                    copiedText === 'brief'
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  }`}
                >
                  {copiedText === 'brief' ? 'Copiat!' : 'Copiază'}
                </button>
                <button
                  onClick={() => window.print()}
                  className="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded-lg text-sm transition"
                >
                  Printează
                </button>
              </div>
            </div>
            <div className="prose prose-invert prose-sm max-w-none">
              <pre className="whitespace-pre-wrap text-gray-300 text-sm leading-relaxed font-sans">
                {data.result.brief}
              </pre>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
