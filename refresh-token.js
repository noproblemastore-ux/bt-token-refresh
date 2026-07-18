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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    locale: 'en-GB',
  });

  let capturedToken = null;

  // Interceptar requests via route — más confiable que page.on('request')
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    
    if (url.includes('api-framework.blueticket.pt')) {
      const headers = request.headers();
      const auth = headers['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        capturedToken = auth.replace('Bearer ', '').trim();
        console.log(`   Token capturado de: ${url.split('?')[0]}`);
      }
    }
    
    await route.continue();
  });

  const page = await context.newPage();
  
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('   Navegando a Jerónimos...');
  
  try {
    await page.goto(JERONIMOS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch(e) {
    console.log(`   Warning navegacion: ${e.message}`);
  }

  // Esperar hasta 20 segundos para que aparezca el token
  console.log('   Esperando token (hasta 20s)...');
  for (let i = 0; i < 20; i++) {
    if (capturedToken) break;
    await sleep(1000);
    console.log(`   ${i + 1}s...`);
  }

  // Si no capturamos el token, intentar hacer scroll para triggear lazy load
  if (!capturedToken) {
    console.log('   Intentando scroll para triggear requests...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(3000);
  }

  await browser.close();

  if (!capturedToken) {
    console.error('ERROR: No se capturó ningún Bearer token después de 23s');
    // Log URL actual y título para debug
    process.exit(1);
  }

  console.log('✅ Token obtenido correctamente');
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
    console.error(`ERROR guardando secret: ${res.status} — ${text}`);
    process.exit(1);
  }
  console.log('   Secret JERONIMOS_TOKEN actualizado en Supabase ✅');
}

async function triggerSync() {
  console.log('\n🚀 Triggering jeronimos-sync Edge Function...');
  const res = await fetch(`https://${SUPABASE_PROJECT_ID}.supabase.co/functions/v1/jeronimos-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
    body: JSON.stringify({}),
  });
  console.log(`   Sync triggered: ${res.status}`);
}

async function main() {
  console.log(`🚀 Jerónimos Token Refresh — ${new Date().toISOString()}\n`);
  const token = await getBearerToken();
  await saveSecret(token);
  await triggerSync();
  console.log('\n✅ Todo listo — token renovado y sync ejecutado');
}

main().catch(err => {
  console.error('ERROR fatal:', err);
  process.exit(1);
});
