'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface FormState {
  description: string;
  type: 'cumparare' | 'inchiriere';
  condition: 'nou' | 'second-hand' | 'indiferent';
  zone: 'local' | 'regional' | 'global';
  zoneLocation: string;
  budgetMin: string;
  budgetMax: string;
  currency: 'RON' | 'EUR' | 'USD' | 'GBP';
  quantity: string;
  unit: string;
  deadline: string;
}

interface ClarificationState {
  questions: string[];
  answers: string[];
  round: number;
}

/**
 * Build request payload from form state and clarifications
 * Extracted to avoid code duplication between handleSubmit and submitClarifications
 */
function buildRequestPayload(
  form: FormState,
  filePaths: string[],
  clarification: ClarificationState | null,
  provider?: string
) {
  return {
    description: form.description,
    type: form.type,
    condition: form.type === 'cumparare' ? form.condition : undefined,
    zone: form.zone,
    zoneLocation: form.zoneLocation || undefined,
    budgetMin: form.budgetMin ? Number(form.budgetMin) : undefined,
    budgetMax: form.budgetMax ? Number(form.budgetMax) : undefined,
    currency: form.currency,
    quantity: Number(form.quantity) || 1,
    unit: form.unit,
    deadline: form.deadline,
    filePaths,
    clarificationRound: clarification?.round || 0,
    previousQuestions: clarification?.questions || [],
    previousAnswers: clarification?.answers || [],
    provider: provider || undefined,
  };
}

export default function SourcingForm() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({
    description: '',
    type: 'cumparare',
    condition: 'indiferent',
    zone: 'regional',
    zoneLocation: '',
    budgetMin: '',
    budgetMax: '',
    currency: 'EUR',
    quantity: '1',
    unit: 'bucăți',
    deadline: '2-saptamani',
  });

  const [files, setFiles] = useState<File[]>([]);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [clarification, setClarification] = useState<ClarificationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiProvider, setAiProvider] = useState<string>('auto');
  const [availableProviders, setAvailableProviders] = useState<{id: string; label: string; available: boolean}[]>([]);

  // Fetch available AI providers on mount
  useEffect(() => {
    fetch('/api/ai')
      .then(res => res.json())
      .then(data => {
        if (data.providers) {
          setAvailableProviders(data.providers.filter((p: {enabled: boolean}) => p.enabled));
        }
        if (data.defaultProvider) {
          setAiProvider(data.defaultProvider);
        }
      })
      .catch(() => { /* silently fail — auto mode works */ });
  }, []);

  const handleFileUpload = async (newFiles: File[]) => {
    if (newFiles.length === 0) return;

    setUploading(true);
    setError(null);

    const formData = new FormData();
    newFiles.forEach(f => formData.append('files', f));
    if (sessionId) formData.append('sessionId', sessionId);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Eroare la încărcare');
        return;
      }

      setFiles(prev => [...prev, ...newFiles]);
      setFilePaths(prev => [...prev, ...data.paths]);
      if (data.sessionId) setSessionId(data.sessionId);
    } catch {
      setError('Eroare la încărcarea fișierelor');
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    handleFileUpload(droppedFiles);
  }, [sessionId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  }, []);

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
    setFilePaths(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const payload = buildRequestPayload(form, filePaths, clarification, aiProvider);

      const res = await fetch('/api/source/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Eroare la procesare');
        return;
      }

      if (data.understood && data.proceed) {
        const genRes = await fetch('/api/source/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            summary: data.summary,
            clarifications: clarification?.questions.map((q, i) => ({
              question: q,
              answer: clarification.answers[i] || '',
            })) || [],
          }),
        });

        const genData = await genRes.json();

        if (!genRes.ok) {
          setError(genData.error || 'Eroare la generare');
          return;
        }

        // Navigate immediately — results page will poll until ready
        router.push(`/results/${genData.id}`);
      } else if (data.questions && data.questions.length > 0) {
        setClarification({
          questions: data.questions,
          answers: new Array(data.questions.length).fill(''),
          round: (clarification?.round || 0) + 1,
        });
      }
    } catch {
      setError('Eroare la comunicarea cu serverul');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClarificationAnswer = (index: number, value: string) => {
    if (!clarification) return;
    const newAnswers = [...clarification.answers];
    newAnswers[index] = value;
    setClarification({ ...clarification, answers: newAnswers });
  };

  const submitClarifications = async () => {
    if (!clarification) return;
    setSubmitting(true);
    setError(null);

    try {
      const payload = buildRequestPayload(form, filePaths, clarification, aiProvider);

      const res = await fetch('/api/source/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Eroare la procesare');
        return;
      }

      if (data.understood && data.proceed) {
        const genRes = await fetch('/api/source/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            summary: data.summary,
            clarifications: clarification.questions.map((q, i) => ({
              question: q,
              answer: clarification.answers[i] || '',
            })),
          }),
        });

        const genData = await genRes.json();

        if (!genRes.ok) {
          setError(genData.error || 'Eroare la generare');
          return;
        }

        // Navigate immediately — results page polls until ready
        router.push(`/results/${genData.id}`);
      } else if (data.questions && data.questions.length > 0) {
        setClarification({
          questions: [...clarification.questions, ...data.questions],
          answers: [...clarification.answers, ...new Array(data.questions.length).fill('')],
          round: clarification.round + 1,
        });
      }
    } catch {
      setError('Eroare la comunicarea cu serverul');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-orange-500 to-red-600 rounded-xl flex items-center justify-center font-bold text-xl">
                S
              </div>
              <div>
                <h1 className="text-xl font-bold text-orange-500">Source</h1>
                <p className="text-gray-400 text-xs">AI Sourcing Platform</p>
              </div>
            </div>
            <button
              onClick={() => router.push('/dashboard')}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition text-gray-300"
            >
              Dashboard
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {clarification ? (
          <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
            <h2 className="text-xl font-semibold mb-4 text-orange-400">
              Clarificări necesare (Runda {clarification.round}/3)
            </h2>
            <p className="text-gray-400 mb-6">
              Pentru a genera cele mai bune recomandări, avem nevoie de câteva clarificări:
            </p>

            <div className="space-y-4">
              {clarification.questions.map((question, index) => (
                <div key={index}>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {question}
                  </label>
                  <input
                    type="text"
                    value={clarification.answers[index] || ''}
                    onChange={(e) => handleClarificationAnswer(index, e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                    placeholder="Răspunsul tău..."
                  />
                </div>
              ))}
            </div>

            {error && (
              <div className="mt-4 p-4 bg-red-900/30 border border-red-700/50 rounded-lg text-red-400">
                {error}
              </div>
            )}

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setClarification(null)}
                className="flex-1 py-3 px-4 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium transition"
              >
                Înapoi la formular
              </button>
              <button
                onClick={submitClarifications}
                disabled={submitting}
                className="flex-1 py-3 px-4 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-400 hover:to-red-500 rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Se procesează...' : 'Continuă'}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
              <label className="block text-lg font-semibold text-white mb-3">
                Descrie ce cauți
              </label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Ex: Am nevoie de un strung CNC pentru piese mici, toleranțe de 0.01mm, producție de serie medie..."
                rows={5}
                required
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 resize-none"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Tip achiziție
                </label>
                <div className="flex gap-4">
                  {[
                    { value: 'cumparare', label: 'Cumpărare' },
                    { value: 'inchiriere', label: 'Închiriere' },
                  ].map((opt) => (
                    <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="type"
                        value={opt.value}
                        checked={form.type === opt.value}
                        onChange={(e) => setForm({ ...form, type: e.target.value as 'cumparare' | 'inchiriere' })}
                        className="w-4 h-4 text-orange-500 bg-gray-800 border-gray-600 focus:ring-orange-500"
                      />
                      <span className="text-white">{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {form.type === 'cumparare' && (
                <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    Condiție produs
                  </label>
                  <div className="flex gap-4 flex-wrap">
                    {[
                      { value: 'nou', label: 'Nou' },
                      { value: 'second-hand', label: 'Second-hand' },
                      { value: 'indiferent', label: 'Indiferent' },
                    ].map((opt) => (
                      <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="condition"
                          value={opt.value}
                          checked={form.condition === opt.value}
                          onChange={(e) => setForm({ ...form, condition: e.target.value as 'nou' | 'second-hand' | 'indiferent' })}
                          className="w-4 h-4 text-orange-500 bg-gray-800 border-gray-600 focus:ring-orange-500"
                        />
                        <span className="text-white">{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
              <label className="block text-sm font-medium text-gray-300 mb-3">
                Zonă geografică
              </label>
              <div className="flex gap-4 flex-wrap">
                {[
                  { value: 'local', label: 'Local', desc: 'Oraș / Județ' },
                  { value: 'regional', label: 'Regional', desc: 'Țară / Europa' },
                  { value: 'global', label: 'Global', desc: 'Oriunde în lume' },
                ].map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex-1 min-w-[120px] p-4 rounded-lg border cursor-pointer transition ${
                      form.zone === opt.value
                        ? 'border-orange-500 bg-orange-500/10'
                        : 'border-gray-700 bg-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name="zone"
                      value={opt.value}
                      checked={form.zone === opt.value}
                      onChange={(e) => setForm({ ...form, zone: e.target.value as 'local' | 'regional' | 'global', zoneLocation: '' })}
                      className="sr-only"
                    />
                    <div className="text-white font-medium">{opt.label}</div>
                    <div className="text-gray-400 text-xs mt-1">{opt.desc}</div>
                  </label>
                ))}
              </div>
              {form.zone !== 'global' && (
                <div className="mt-3">
                  <input
                    type="text"
                    value={form.zoneLocation}
                    onChange={(e) => setForm({ ...form, zoneLocation: e.target.value })}
                    placeholder={form.zone === 'local' ? 'Ex: București, Cluj-Napoca, Timișoara...' : 'Ex: România, Germania, Europa de Est...'}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
                    autoComplete="off"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Buget (opțional)
                </label>
                {/* Currency selector — prominent, separate row */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs text-gray-400">Monedă:</span>
                  {(['RON', 'EUR', 'USD', 'GBP'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setForm({ ...form, currency: c })}
                      className={`px-3 py-1 rounded-lg text-sm font-semibold transition ${
                        form.currency === c
                          ? 'bg-orange-500 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={form.budgetMin}
                    onChange={(e) => setForm({ ...form, budgetMin: e.target.value })}
                    placeholder={`Min ${form.currency}`}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
                  />
                  <span className="flex items-center text-gray-500">-</span>
                  <input
                    type="number"
                    value={form.budgetMax}
                    onChange={(e) => setForm({ ...form, budgetMax: e.target.value })}
                    placeholder={`Max ${form.currency}`}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Cantitate
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                    min="1"
                    required
                    className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white focus:border-orange-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    value={form.unit}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                    placeholder="bucăți, kg, set..."
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
              <label className="block text-sm font-medium text-gray-300 mb-3">
                Urgență / Deadline
              </label>
              <select
                value={form.deadline}
                onChange={(e) => setForm({ ...form, deadline: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white focus:border-orange-500 focus:outline-none"
              >
                <option value="asap">ASAP</option>
                <option value="1-saptamana">1 săptămână</option>
                <option value="2-saptamani">2 săptămâni</option>
                <option value="1-luna">1 lună</option>
                <option value="3-luni">3 luni</option>
                <option value="fara-urgenta">Fără urgență</option>
              </select>
            </div>

            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
              <label className="block text-sm font-medium text-gray-300 mb-3">
                Fișiere atașate (opțional)
              </label>
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                className={`border-2 border-dashed rounded-lg p-8 text-center transition ${
                  dragActive
                    ? 'border-orange-500 bg-orange-500/10'
                    : 'border-gray-700 hover:border-gray-600'
                }`}
              >
                <input
                  type="file"
                  multiple
                  accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.dwg"
                  onChange={(e) => {
                    if (e.target.files) handleFileUpload(Array.from(e.target.files));
                  }}
                  className="hidden"
                  id="file-input"
                />
                <label htmlFor="file-input" className="cursor-pointer">
                  <div className="text-gray-400">
                    {uploading ? (
                      <span className="text-orange-400">Se încarcă...</span>
                    ) : (
                      <>
                        Trage fișierele aici sau{' '}
                        <span className="text-orange-400 underline">selectează</span>
                      </>
                    )}
                  </div>
                  <div className="text-gray-500 text-sm mt-2">
                    Imagini, PDF, Word, Excel, DWG
                  </div>
                </label>
              </div>

              {files.length > 0 && (
                <div className="mt-4 space-y-2">
                  {files.map((file, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-2"
                    >
                      <span className="text-sm text-gray-300 truncate">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => removeFile(index)}
                        className="text-gray-500 hover:text-red-400 transition"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* AI Provider Selection */}
            {availableProviders.length > 0 && (
              <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6">
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  Motor AI (opțional)
                </label>
                <select
                  value={aiProvider}
                  onChange={(e) => setAiProvider(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white focus:border-orange-500 focus:outline-none"
                >
                  <option value="auto">Auto (Round-robin cu fallback)</option>
                  {availableProviders.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.label}{!p.available ? ' (lipsește cheia API)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-gray-500 text-xs mt-2">
                  Claude este recomandat pentru sourcing B2B din România. Auto selectează automat cel mai bun provider disponibil.
                </p>
              </div>
            )}

            {error && (
              <div className="p-4 bg-red-900/30 border border-red-700/50 rounded-lg text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !form.description.trim()}
              className="w-full py-4 px-6 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-400 hover:to-red-500 rounded-xl font-semibold text-lg transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-orange-500/20"
            >
              {submitting ? 'Se procesează...' : 'Caută furnizori'}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
