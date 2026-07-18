const { chromium } = require('playwright');

const JERONIMOS_URL       = 'https://mmp.bymeoblueticket.pt/en/event/14759/mosteiro-dos-jeronimos-claustro';
const SUPABASE_PROJECT_ID = 'odhogdwxafqdlfvfbsux';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_MGMT_TOKEN   = process.env.SUPABASE_MANAGEMENT_TOKEN;

if (!SUPABASE_SERVICE_ROLE || !SUPABASE_MGMT_TOKEN) {
  console.error('ERROR: Faltan variables de entorno');
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-GB',
    viewport: { width: 1280, height: 800 },
  });

  let capturedToken = null;

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const headers = request.headers();
    
    if (url.includes('api-framework.blueticket.pt')) {
      console.log(`   api-framework request: ${url.substring(0, 80)}`);
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
  });

  console.log('   Navegando a Jerónimos...');
  await page.goto(JERONIMOS_URL, { waitUntil: 'networkidle', timeout: 45000 });
  console.log(`   Título: ${await page.title()}`);
  
  // Esperar que cargue el calendario
  await sleep(3000);
  
  // Intentar hacer click en la primera fecha disponible del calendario
  console.log('   Buscando fecha disponible para clickear...');
  
  try {
    // Buscar botones de fecha disponibles (no disabled)
    const dateButton = await page.$('button.day:not([disabled]), .flatpickr-day:not(.disabled):not(.flatpickr-disabled), [data-date]:not([disabled])');
    if (dateButton) {
      console.log('   Click en fecha disponible...');
      await dateButton.click();
      await sleep(5000);
    } else {
      console.log('   No encontré botón de fecha, intentando selector alternativo...');
      // Intentar con cualquier elemento clickeable del calendario
      const altButton = await page.$('.available, .day.available, span.flatpickr-day:not(.disabled)');
      if (altButton) {
        await altButton.click();
        await sleep(5000);
      }
    }
  } catch(e) {
    console.log(`   Warning click: ${e.message}`);
  }

  // Esperar token hasta 15s más
  for (let i = 0; i < 15; i++) {
    if (capturedToken) break;
    await sleep(1000);
    if (i % 5 === 4) console.log(`   ${i + 1}s adicionales esperando...`);
  }

  // Log todos los elementos de fecha para debug
  if (!capturedToken) {
    const buttons = await page.$$eval('button, [class*="day"], [class*="date"]', els => 
      els.slice(0, 10).map(e => ({ tag: e.tagName, class: e.className.substring(0, 50), text: e.textContent?.trim().substring(0, 20) }))
    );
    console.log('   Elementos de fecha encontrados:', JSON.stringify(buttons));
  }

  await browser.close();

  if (!capturedToken) {
    console.error('ERROR: No se capturó el Bearer token');
    process.exit(1);
  }

  return capturedToken;
}

async function saveSecret(token) {
  console.log('\n💾 Guardando token en Supabase...');
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
