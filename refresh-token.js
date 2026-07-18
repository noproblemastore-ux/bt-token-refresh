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
      const auth = headers['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        capturedToken = auth.replace('Bearer ', '').trim();
        console.log(`   ✅ Token capturado de: ${url.substring(0, 60)}`);
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
  console.log(`   Página cargada. Esperando widget de slots (5s)...`);
  await sleep(5000);

  // Log del HTML del área de slots para entender la estructura
  const slotAreaHtml = await page.evaluate(() => {
    const slot = document.querySelector('#slot-widget, .slot-widget, [id*="slot"], [class*="slot-picker"], iframe');
    if (slot) return slot.outerHTML.substring(0, 500);
    
    // Si hay iframe, log su src
    const iframes = Array.from(document.querySelectorAll('iframe')).map(i => i.src);
    if (iframes.length) return 'IFRAMES: ' + iframes.join(', ');
    
    // Buscar el contenedor del widget
    const containers = ['#event-slots', '#timeslot', '.timeslot', '[data-widget]', '#purchase-widget'];
    for (const sel of containers) {
      const el = document.querySelector(sel);
      if (el) return `${sel}: ${el.outerHTML.substring(0, 300)}`;
    }
    
    return 'No encontré widget de slots. Body classes: ' + document.body.className;
  });
  console.log('   Widget HTML:', slotAreaHtml);

  // Intentar click en cualquier fecha/día visible
  const clicked = await page.evaluate(() => {
    // Buscar todos los elementos clickeables que parezcan fechas
    const selectors = [
      '[class*="fri"]', '[class*="sat"]', '[class*="sun"]', '[class*="tue"]', '[class*="wed"]', '[class*="thu"]',
      '[data-date]', '[data-day]', '.day', '.date-cell',
      'td:not(.disabled)', '[role="gridcell"]:not([aria-disabled])'
    ];
    
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          el.click();
          return `Clicked: ${sel} → ${el.className} text:${el.textContent?.trim().substring(0,10)}`;
        }
      }
    }
    return 'No encontré elemento para clickear';
  });
  console.log('   Click result:', clicked);
  
  await sleep(8000);

  if (!capturedToken) {
    // Intentar hacer scroll y esperar más
    await page.evaluate(() => window.scrollBy(0, 300));
    await sleep(5000);
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
