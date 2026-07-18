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

  // Interceptar a nivel de context — captura requests de TODOS los frames
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const headers = request.headers();
    
    if (url.includes('api-framework.blueticket.pt')) {
      console.log(`   api-framework: ${url.substring(0, 80)}`);
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
  console.log(`   Página cargada.`);
  await sleep(3000);

  // Log todos los iframes de la página
  const frames = page.frames();
  console.log(`   Frames encontrados: ${frames.length}`);
  for (const frame of frames) {
    console.log(`   Frame: ${frame.url().substring(0, 100)}`);
  }

  // Buscar el frame del slot widget
  const slotFrame = frames.find(f => 
    f.url().includes('slot') || 
    f.url().includes('timeslot') || 
    f.url().includes('api-framework') ||
    f.url().includes('LoadSession') ||
    (f.url() !== 'about:blank' && f.url() !== '' && !f.url().includes('cookie') && !f.url().includes('usp'))
  );

  if (slotFrame) {
    console.log(`   Slot frame encontrado: ${slotFrame.url()}`);
    await sleep(2000);
    
    // Log HTML del frame
    const frameHtml = await slotFrame.evaluate(() => document.body?.innerHTML?.substring(0, 500) || 'empty');
    console.log(`   Frame HTML: ${frameHtml}`);

    // Intentar click en fecha dentro del frame
    const clicked = await slotFrame.evaluate(() => {
      const selectors = ['[class*="fri"]', '[class*="sat"]', '[class*="tue"]', '[class*="wed"]', '[class*="thu"]', 
        '.day', '.date', '[data-date]', 'td', 'li'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return `Clicked ${sel}: ${el.className}`; }
      }
      return 'No element found in frame';
    });
    console.log(`   Frame click: ${clicked}`);
    await sleep(5000);
  } else {
    console.log('   No encontré slot frame, esperando más...');
    await sleep(10000);
    
    // Log frames de nuevo después de esperar
    const frames2 = page.frames();
    console.log(`   Frames después de esperar: ${frames2.length}`);
    for (const f of frames2) {
      console.log(`   - ${f.url().substring(0, 100)}`);
    }
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
