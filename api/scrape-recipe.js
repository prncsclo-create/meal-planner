const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');

function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) === 6) {
    const ip = address.toLowerCase();
    if (ip.startsWith('::ffff:')) return isPrivateAddress(ip.slice(7));
    return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') ||
      /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.startsWith('2001:db8:');
  }
  return true;
}

async function validatePublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid recipe URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP or HTTPS recipe links are supported.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('That address is not a public website.');
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('That address is not a public website.');
  } else {
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error('Could not resolve that website. Check the link and try again.'); }
    if (!addresses.length || addresses.some(record => isPrivateAddress(record.address))) {
      throw new Error('That website does not resolve to a public address.');
    }
  }
  url.hash = '';
  return url;
}

function decodeEntities(value) {
  return String(value || '').replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, code) => {
    const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  }).replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function cleanText(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').replace(/^\s*\d+[.)]\s*/, '').trim();
}
function metaContent(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attr = name => {
      const match = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(["\\'])([\\s\\S]*?)\\1', 'i'));
      return match ? decodeEntities(match[2]) : '';
    };
    if (attr('property').toLowerCase() === key.toLowerCase() || attr('name').toLowerCase() === key.toLowerCase()) return attr('content');
  }
  return '';
}
function allOfType(value, type) {
  const types = Array.isArray(value && value['@type']) ? value['@type'] : [value && value['@type']];
  return types.some(item => String(item || '').toLowerCase() === type.toLowerCase());
}
function findRecipe(value) {
  if (Array.isArray(value)) { for (const item of value) { const found = findRecipe(item); if (found) return found; } return null; }
  if (!value || typeof value !== 'object') return null;
  if (allOfType(value, 'Recipe')) return value;
  if (Array.isArray(value['@graph'])) return findRecipe(value['@graph']);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') { const found = findRecipe(nested); if (found) return found; }
  }
  return null;
}
function flattenInstructions(value) {
  if (!value) return [];
  if (typeof value === 'string') return [cleanText(value)].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(flattenInstructions);
  if (typeof value === 'object') {
    if (value.text || value.name) return [cleanText(value.text || value.name)].filter(Boolean);
    return flattenInstructions(value.itemListElement || value.steps || value.recipeInstructions);
  }
  return [];
}
function imageValue(value) {
  if (Array.isArray(value)) return imageValue(value[0]);
  if (value && typeof value === 'object') return imageValue(value.url || value.contentUrl || value.thumbnailUrl);
  return typeof value === 'string' ? value.trim() : '';
}
function duration(value) {
  if (!value) return '';
  const text = String(value).trim();
  const match = text.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return text;
  const parts = [];
  if (match[1]) parts.push(match[1] + ' day' + (match[1] === '1' ? '' : 's'));
  if (match[2]) parts.push(match[2] + ' hr');
  if (match[3]) parts.push(match[3] + ' min');
  if (match[4]) parts.push(match[4] + ' sec');
  return parts.join(' ') || text;
}
function collectMicrodata(html, prop) {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const values = [];
  const meta = new RegExp('<meta\\b[^>]*\\bitemprop\\s*=\\s*["\\']' + escaped + '["\\'][^>]*>', 'gi');
  for (const tag of html.match(meta) || []) {
    const content = tag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
    if (content) values.push(cleanText(content[2]));
  }
  const node = new RegExp('<([a-z][\\w:-]*)\\b(?=[^>]*\\bitemprop\\s*=\\s*["\\']' + escaped + '["\\'])[^>]*>([\\s\\S]*?)<\\/\\1\\s*>', 'gi');
  let match;
  while ((match = node.exec(html))) values.push(cleanText(match[2]));
  return [...new Set(values.filter(Boolean))];
}
function categoryFor(values) {
  const text = values.join(' ').toLowerCase();
  if (/breakfast|brunch/.test(text)) return 'Breakfast';
  if (/lunch|salad|sandwich|soup/.test(text)) return 'Lunch';
  if (/snack|dessert|cookie|cake|smoothie/.test(text)) return 'Snack';
  return 'Dinner';
}
function parseRecipe(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  let schema = null;
  for (const match of scripts) {
    try { schema = findRecipe(JSON.parse(match[1].replace(/^\s*<!--|-->\s*$/g, ''))); } catch {}
    if (schema) break;
  }
  const microIngredients = collectMicrodata(html, 'recipeIngredient');
  const ingredients = (schema && Array.isArray(schema.recipeIngredient) ? schema.recipeIngredient : microIngredients)
    .map(value => cleanText(value)).filter(Boolean);
  const microInstructions = collectMicrodata(html, 'recipeInstructions');
  const instructions = schema ? flattenInstructions(schema.recipeInstructions) : microInstructions;
  const title = cleanText(schema && (schema.name || schema.headline)) || metaContent(html, 'og:title') ||
    cleanText((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) ||
    cleanText((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const image = imageValue(schema && schema.image) || metaContent(html, 'og:image');
  const categories = schema ? [schema.recipeCategory, schema.recipeCuisine, schema.keywords].flatMap(v => Array.isArray(v) ? v : v ? String(v).split(/[,;]/) : []) : [];
  const category = categoryFor(categories.concat(title));
  const tags = [...new Set(categories.map(cleanText).filter(Boolean))].slice(0, 12);
  const yieldValue = schema && schema.recipeYield;
  const servings = Array.isArray(yieldValue) ? yieldValue.join(', ') : String(yieldValue || '').trim();
  const recipe = {
    name: title,
    prepTime: duration(schema && schema.prepTime),
    cookTime: duration(schema && schema.cookTime),
    totalTime: duration(schema && schema.totalTime),
    servings,
    ingredients,
    instructions,
    imageUrl: image,
    tags,
    category
  };
  if (!recipe.name || !recipe.ingredients.length) return null;
  return recipe;
}

async function fetchHtml(initialUrl) {
  let current = await validatePublicUrl(initialUrl);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TableRecipeImporter/1.0)', 'Accept': 'text/html,application/xhtml+xml' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 4) throw new Error('The recipe page redirected too many times.');
      const location = response.headers.get('location');
      if (!location) throw new Error('The recipe page returned an invalid redirect.');
      current = await validatePublicUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error('The recipe website returned HTTP ' + response.status + '.');
    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error('That link did not return an HTML recipe page.');
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 2_000_000) throw new Error('That recipe page is too large to import.');
    const html = await response.text();
    if (html.length > 2_000_000) throw new Error('That recipe page is too large to import.');
    return html;
  }
  throw new Error('Could not follow the recipe page redirect.');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST to import a recipe URL.' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const value = body && typeof body.url === 'string' ? body.url.trim() : '';
    if (!value || value.length > 2048) return res.status(400).json({ error: 'Paste a valid recipe URL to import.' });
    const html = await fetchHtml(value);
    const recipe = parseRecipe(html);
    if (!recipe) return res.status(422).json({ error: 'I could not find a recipe title and ingredient list on that page. You can still enter it manually.' });
    return res.status(200).json({ recipe });
  } catch (error) {
    const message = error && error.name === 'TimeoutError' ? 'The recipe website took too long to respond. Try again or enter it manually.' :
      (error && error.message) || 'Could not import that recipe. Please check the link or enter it manually.';
    return res.status(400).json({ error: message });
  }
};
