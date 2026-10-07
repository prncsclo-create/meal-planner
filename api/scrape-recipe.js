const dns = require('node:dns/promises');
const net = require('node:net');

function privateIp(value) {
  const version = net.isIP(value);
  if (version === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    const ip = value.toLowerCase();
    if (ip.startsWith('::ffff:')) return privateIp(ip.slice(7));
    return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') ||
      /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.startsWith('2001:db8:');
  }
  return true;
}
async function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid recipe URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP or HTTPS recipe links are supported.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('That address is not a public website.');
  if (net.isIP(host)) {
    if (privateIp(host)) throw new Error('That address is not a public website.');
  } else {
    let records;
    try { records = await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error('Could not resolve that website. Check the link and try again.'); }
    if (!records.length || records.some(record => privateIp(record.address))) throw new Error('That website does not resolve to a public address.');
  }
  url.hash = '';
  return url;
}
function decode(value) {
  return String(value || '').replace(/&#(x[\da-f]+|\d+);?/gi, (_, code) => {
    const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  }).replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function text(value) { return decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function instruction(value) { return text(value).replace(/^\s*(?:step\s*)?\d+[.)]\s*/i, '').trim(); }
function attr(tag, name) {
  const q = String.fromCharCode(34, 39);
  const match = tag.match(new RegExp('\\b' + name + '\\s*=\\s*([' + q + '])([\\s\\S]*?)\\1', 'i'));
  return match ? decode(match[2]) : '';
}
function meta(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if ((attr(tag, 'property') || attr(tag, 'name')).toLowerCase() === key.toLowerCase()) return attr(tag, 'content');
  }
  return '';
}
function microdata(html, property) {
  const q = String.fromCharCode(34, 39), values = [];
  const metapat = new RegExp(`<meta\\b[^>]*\\bitemprop\\s*=\\s*[${q}]${property}[${q}][^>]*>`, 'gi');
  for (const tag of html.match(metapat) || []) if (attr(tag, 'content')) values.push(text(attr(tag, 'content')));
  const nodepat = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\bitemprop\\s*=\\s*[${q}]${property}[${q}][^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
  let match;
  while ((match = nodepat.exec(html))) values.push(text(match[2]));
  return [...new Set(values.filter(Boolean))];
}
function isRecipe(value) {
  const types = Array.isArray(value && value['@type']) ? value['@type'] : [value && value['@type']];
  return types.some(type => String(type || '').toLowerCase() === 'recipe');
}
function findRecipe(value) {
  if (Array.isArray(value)) { for (const item of value) { const found = findRecipe(item); if (found) return found; } return null; }
  if (!value || typeof value !== 'object') return null;
  if (isRecipe(value)) return value;
  for (const child of Object.values(value)) if (child && typeof child === 'object') { const found = findRecipe(child); if (found) return found; }
  return null;
}
function instructions(value) {
  if (!value) return [];
  if (typeof value === 'string') return [instruction(value)].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(instructions);
  if (typeof value === 'object') return value.text || value.name ? [instruction(value.text || value.name)].filter(Boolean) : instructions(value.itemListElement || value.steps || value.recipeInstructions);
  return [];
}
function image(value) {
  if (Array.isArray(value)) return image(value[0]);
  if (value && typeof value === 'object') return image(value.url || value.contentUrl || value.thumbnailUrl);
  return typeof value === 'string' ? value.trim() : '';
}
function duration(value) {
  if (!value) return '';
  const match = String(value).trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return String(value).trim();
  return [match[1] && match[1] + ' day' + (match[1] === '1' ? '' : 's'), match[2] && match[2] + ' hr', match[3] && match[3] + ' min', match[4] && match[4] + ' sec'].filter(Boolean).join(' ');
}
function parse(html) {
  let recipe = null;
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { recipe = findRecipe(JSON.parse(match[1].replace(/^\s*<!--|-->\s*$/g, ''))); } catch {}
    if (recipe) break;
  }
  const ingredients = (recipe && Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : microdata(html, 'recipeIngredient')).map(text).filter(Boolean);
  const steps = recipe ? instructions(recipe.recipeInstructions) : microdata(html, 'recipeInstructions').map(instruction);
  const title = text(recipe && (recipe.name || recipe.headline)) || meta(html, 'og:title') || text((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) || text((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const values = recipe ? [recipe.recipeCategory, recipe.recipeCuisine, recipe.keywords].flatMap(v => Array.isArray(v) ? v : v ? String(v).split(/[,;]/) : []) : [];
  const categoryText = values.concat(title).join(' ').toLowerCase();
  const category = /breakfast|brunch/.test(categoryText) ? 'Breakfast' : /lunch|salad|sandwich|soup/.test(categoryText) ? 'Lunch' : /snack|dessert|cookie|cake|smoothie/.test(categoryText) ? 'Snack' : 'Dinner';
  const servings = recipe && recipe.recipeYield;
  const imageValue = image(recipe && recipe.image) || meta(html, 'og:image');
  if (!title || !ingredients.length) return null;
  return { name: title, prepTime: duration(recipe && recipe.prepTime), cookTime: duration(recipe && recipe.cookTime), totalTime: duration(recipe && recipe.totalTime), servings: Array.isArray(servings) ? servings.join(', ') : String(servings || '').trim(), ingredients, instructions: steps, imageUrl: imageValue, tags: [...new Set(values.map(text).filter(Boolean))].slice(0, 12), category };
}
async function fetchHtml(value) {
  let url = await publicUrl(value);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TableRecipeImporter/1.0)', Accept: 'text/html,application/xhtml+xml' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 4) throw new Error('The recipe page redirected too many times.');
      const location = response.headers.get('location');
      if (!location) throw new Error('The recipe page returned an invalid redirect.');
      url = await publicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error('The recipe website returned HTTP ' + response.status + '.');
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) throw new Error('That link did not return an HTML recipe page.');
    if (Number(response.headers.get('content-length') || 0) > 2_000_000) throw new Error('That recipe page is too large to import.');
    const html = await response.text();
    if (html.length > 2_000_000) throw new Error('That recipe page is too large to import.');
    return html;
  }
  throw new Error('Could not follow the recipe page redirect.');
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST to import a recipe URL.' }); }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const url = body && typeof body.url === 'string' ? body.url.trim() : '';
    if (!url || url.length > 2048) return res.status(400).json({ error: 'Paste a valid recipe URL to import.' });
    const recipe = parse(await fetchHtml(url));
    if (!recipe) return res.status(422).json({ error: 'I could not find a recipe title and ingredient list on that page. You can still enter it manually.' });
    return res.status(200).json({ recipe });
  } catch (error) {
    const message = error && error.name === 'TimeoutError' ? 'The recipe website took too long to respond. Try again or enter it manually.' : (error && error.message) || 'Could not import that recipe. Please check the link or enter it manually.';
    return res.status(400).json({ error: message });
  }
};
