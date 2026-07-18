const { chromium } = require('playwright');

// ── Config ───────────────────────────────────────────────────────────────────
const JERONIMOS_URL       = 'https://mmp.bymeoblueticket.pt/en/event/14759/mosteiro-dos-jeronimos-claustro';
const SUPABASE_URL        = 'https://odhogdwxafqdlfvfbsux.supabase.co';
const SUPABASE_PROJECT_ID = 'odhogdwxafqdlfvfbsux';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_MGMT_TOKEN   = process.env.SUPABASE_MANAGEMENT_TOKEN;

if (!SUPABASE_SERVICE_ROLE || !SUPABASE_MGMT_TOKEN) {
  console.error('ERROR: Faltan SUPABASE_SERVICE_ROLE_KEY o SUPABASE_MANAGEMENT_TOKEN');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: Get Bearer token via Playwright ───────────────────────────────────
async function getBearerToken() {
  console.log('🌐 Lanzando Chromium...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    locale: 'en-GB',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  let capturedToken = null;

  // Intercept requests to api-framework.blueticket.pt and capture Bearer token
  page.on('request', request => {
    const url = request.url();
    if (url.includes('api-framework.blueticket.pt')) {
      const auth = request.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        capturedToken = auth.replace('Bearer ', '').trim();
        console.log(`   Token capturado (${capturedToken.length} chars)`);
      }
    }
  });

  console.log('   Navegando a Jerónimos...');
  await page.goto(JERONIMOS_URL, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('   Esperando que carguen los slots (5s)...');
  await sleep(5000);

  await browser.close();

  if (!capturedToken) {
    console.error('ERROR: No se capturó ningún Bearer token');
    process.exit(1);
  }

  console.log('✅ Token obtenido correctamente');
  return capturedToken;
}

// ── Step 2: Save token to Supabase secret ────────────────────────────────────
async function saveSecret(token) {
  console.log('\n💾 Guardando token en Supabase secret...');
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_ID}/secrets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_MGMT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ name: 'JERONIMOS_TOKEN', value: token }]),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`ERROR guardando secret: ${res.status} — ${text}`);
    process.exit(1);
  }
  console.log('   Secret JERONIMOS_TOKEN actualizado en Supabase');
}

// ── Step 3: Redeploy Edge Function so it picks up new secret ─────────────────
async function redeployEdgeFunction() {
  console.log('\n🚀 Triggering Edge Function redeploy...');
  // Just call the function once to warm it up with new secret
  const res = await fetch(`${SUPABASE_URL}/functions/v1/jeronimos-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
    body: JSON.stringify({}),
  });
  console.log(`   Sync triggered: ${res.status}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 Jerónimos Token Refresh — ${new Date().toISOString()}\n`);

  const token = await getBearerToken();
  await saveSecret(token);
  await redeployEdgeFunction();

  console.log('\n✅ Todo listo — token renovado y sync ejecutado');
}

main().catch(err => {
  console.error('ERROR fatal:', err);
  process.exit(1);
});
