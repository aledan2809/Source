/**
 * Integration tests for Source API endpoints
 * Run: npx tsx src/__tests__/api.test.ts
 *
 * Prerequisites: Server running on localhost:3030
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:3030';
const TOKEN = process.env.ACCESS_TOKEN || '';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

async function run() {
  console.log(`\n🧪 Source API Integration Tests`);
  console.log(`   URL: ${BASE_URL}`);
  console.log(`   Auth: ${TOKEN ? 'yes' : 'no (dev mode)'}\n`);

  // ── Health Check ──
  console.log('📋 Health Check');
  await test('GET /api/health returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert(res.ok, `Status: ${res.status}`);
    const data = await res.json();
    assert(data.status === 'healthy' || data.status === 'degraded' || data.status === 'unhealthy', `Unexpected status: ${data.status}`);
    assert(!!data.timestamp, 'Missing timestamp');
    assert(!!data.checks, 'Missing checks');
  });

  await test('Health check includes all components', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const data = await res.json();
    const expectedChecks = ['auth', 'google_cse', 'ai_provider', 'data_dir'];
    for (const check of expectedChecks) {
      assert(check in data.checks, `Missing check: ${check}`);
    }
  });

  // ── Dashboard ──
  console.log('\n📋 Dashboard');
  await test('GET /api/source/dashboard returns stats', async () => {
    const res = await fetch(`${BASE_URL}/api/source/dashboard`, { headers: headers() });
    assert(res.ok, `Status: ${res.status}`);
    const data = await res.json();
    assert(data.stats && typeof data.stats.total === 'number', 'Missing stats.total');
    assert(data.stats && typeof data.stats.successRate === 'number', 'Missing stats.successRate');
    assert(Array.isArray(data.recent), 'recent not an array');
  });

  // ── Validation ──
  console.log('\n📋 Validation');
  await test('POST /api/source/interpret rejects empty body', async () => {
    const res = await fetch(`${BASE_URL}/api/source/interpret`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({}),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /api/source/interpret rejects missing description', async () => {
    const res = await fetch(`${BASE_URL}/api/source/interpret`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        type: 'cumparare',
        zone: 'regional',
        currency: 'EUR',
        quantity: 1,
        unit: 'buc',
        deadline: '2-saptamani',
      }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /api/source/interpret accepts display text types (refinement compat)', async () => {
    const res = await fetch(`${BASE_URL}/api/source/interpret`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        description: 'Test produs',
        type: 'Cumpărare',
        zone: 'Regional',
        currency: 'EUR',
        quantity: 1,
        unit: 'buc',
        deadline: '2 săptămâni',
      }),
    });
    // Should not be 400 (validation) — may be 200 or 500 (AI call) depending on provider config
    assert(res.status !== 400, `Validation rejected display text: ${res.status}`);
  });

  // ── Upload ──
  console.log('\n📋 Upload');
  await test('POST /api/upload rejects no files', async () => {
    const formData = new FormData();
    const h: Record<string, string> = {};
    if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: h,
      body: formData,
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /api/upload accepts valid file', async () => {
    const formData = new FormData();
    const blob = new Blob(['test content'], { type: 'application/pdf' });
    formData.append('files', blob, 'test.pdf');
    const h: Record<string, string> = {};
    if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: h,
      body: formData,
    });
    assert(res.ok, `Status: ${res.status}`);
    const data = await res.json();
    assert(Array.isArray(data.paths), 'Missing paths array');
    assert(data.paths[0].startsWith('/api/uploads/'), `Upload path not protected: ${data.paths[0]}`);
    assert(!!data.sessionId, 'Missing sessionId');
  });

  // ── Results ──
  console.log('\n📋 Results');
  await test('GET /api/source/results/nonexistent returns 404', async () => {
    const res = await fetch(`${BASE_URL}/api/source/results/nonexistent-id-12345`, { headers: headers() });
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // ── Upload Serve (protected) ──
  console.log('\n📋 Upload Security');
  await test('GET /api/uploads/../../etc/passwd blocked', async () => {
    const res = await fetch(`${BASE_URL}/api/uploads/..%2F..%2Fetc%2Fpasswd`, { headers: headers() });
    assert(res.status === 400 || res.status === 404, `Expected 400/404, got ${res.status}`);
  });

  // ── Summary ──
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'─'.repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
