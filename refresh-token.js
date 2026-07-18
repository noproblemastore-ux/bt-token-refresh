const { chromium } = require('playwright');

const JERONIMOS_URL       = 'https://mmp.bymeoblueticket.pt/en/event/14759/mosteiro-dos-jeronimos-claustro';
const SUPABASE_PROJECT_ID = 'odhogdwxafqdlfvfbsux';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_MGMT_TOKEN   = process.env.SUPABASE_MANAGEMENT_TOKEN;

if (!SUPABASE_SERVICE_ROLE || !SUPABASE_MGMT_TOKEN) {
  console.error('ERROR: Faltan SUPABASE_SERVICE_ROLE_KEY o SUPABASE_MANAGEMENT_TOKEN');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getBearerToken() {
  console.log('🌐 Lanzando Chromium...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-GB',
    viewport: { width: 1280, height: 800 },
  });

  let capturedToken = null;
  const allRequests = [];

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const headers = request.headers();
    
    // Log ALL requests for debug
    allRequests.push(url);
    
    if (url.includes('api-framework.blueticket.pt') || url.includes('blueticket')) {
      console.log(`   Blueticket request: ${url.substring(0, 80)}`);
      const auth = headers['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        capturedToken = auth.replace('Bearer ', '').trim();
        console.log(`   ✅ Token capturado!`);
      }
    }
    
    await route.continue();
  });

  const page = await context.newPage();
  
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  });

  console.log('   Navegando a Jerónimos...');
  
  try {
    await page.goto(JERONIMOS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log(`   Página cargada. Título: ${await page.title()}`);
    console.log(`   URL actual: ${page.url()}`);
  } catch(e) {
    console.log(`   Warning: ${e.message}`);
    console.log(`   URL actual: ${page.url()}`);
  }

  // Esperar 25 segundos
  for (let i = 0; i < 25; i++) {
    if (capturedToken) break;
    await sleep(1000);
    if (i % 5 === 4) console.log(`   ${i + 1}s esperando...`);
  }

  // Log todos los dominios que se contactaron
  const domains = [...new Set(allRequests.map(u => {
    try { return new URL(u).hostname; } catch { return u; }
  }))];
  console.log(`\n   Dominios contactados: ${domains.join(', ')}`);

  await browser.close();

  if (!capturedToken) {
    console.error('ERROR: No se capturó ningún Bearer token');
    process.exit(1);
  }

  return capturedToken;
}

async function saveSecret(token) {
  console.log('\n💾 Guardando token en Supabase secret...');
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_ID}/secrets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_MGMT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ name: 'JERONIMOS_TOKEN', value: token }]),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`ERROR: ${res.status} — ${text}`);
    process.exit(1);
  }
  console.log('   ✅ Secret actualizado');
}

async function triggerSync() {
  console.log('\n🚀 Triggering jeronimos-sync...');
  const res = await fetch(`https://${SUPABASE_PROJECT_ID}.supabase.co/functions/v1/jeronimos-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
    body: JSON.stringify({}),
  });
  console.log(`   Sync: ${res.status}`);
}

async function main() {
  console.log(`🚀 Jerónimos Token Refresh — ${new Date().toISOString()}\n`);
  const token = await getBearerToken();
  await saveSecret(token);
  await triggerSync();
  console.log('\n✅ Listo');
}

main().catch(err => {
  console.error('ERROR fatal:', err);
  process.exit(1);
});
