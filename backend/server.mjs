import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await loadEnv(join(root, '.env'));

const port = Number(process.env.PORT || 8787);
const appOrigins = new Set((process.env.APP_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`)
  .split(',').map((value) => value.trim()).filter(Boolean));
const maxBodyBytes = 4096;
const maxResponseBytes = 1_000_000;

function loadEnv(path) {
  return readFile(path, 'utf8').then((contents) => {
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || Object.hasOwn(process.env, match[1])) continue;
      process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function validateSearch(input) {
  const origin = String(input.origin || '').trim().toUpperCase();
  const destination = String(input.destination || '').trim().toUpperCase();
  const departureDate = String(input.departureDate || '').trim();
  const passengers = Number(input.passengers ?? 1);
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) {
    throw new Error('出发和到达地必须是不同的 3 位 IATA 机场/城市代码。');
  }
  const parsedDate = new Date(`${departureDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate) || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== departureDate) {
    throw new Error('出发日期格式应为 YYYY-MM-DD。');
  }
  if (!Number.isInteger(passengers) || passengers < 1 || passengers > 9) {
    throw new Error('旅客人数必须为 1 到 9 人。');
  }
  return { origin, destination, departureDate, passengers };
}

const FLIGHTAPI_BASE_URL = 'https://api.flightapi.io/onewaytrip';

export function validateFlightApiSearch(input) {
  const origin = String(input.origin || '').trim().toUpperCase();
  const destination = String(input.destination || '').trim().toUpperCase();
  const departureDate = String(input.departureDate || '').trim();
  const adults = Number(input.adults ?? 1);
  const children = Number(input.children ?? 0);
  const infants = Number(input.infants ?? 0);
  const cabinClass = String(input.cabinClass || 'Economy');
  const currency = String(input.currency || 'USD').trim().toUpperCase();
  const region = String(input.region || 'US').trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) {
    throw new Error('出发和到达地必须是不同的 3 位 IATA 机场代码。');
  }
  const parsedDate = new Date(`${departureDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate) || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== departureDate) {
    throw new Error('出发日期格式应为 YYYY-MM-DD。');
  }
  if (departureDate < new Date().toISOString().slice(0, 10)) throw new Error('出发日期必须是今天或未来日期。');
  if (![adults, children, infants].every(Number.isInteger) || adults < 1 || adults > 9 || children < 0 || infants < 0 || adults + children + infants > 9) {
    throw new Error('旅客总数须为 1 到 9 人，且至少有 1 位成人。');
  }
  if (!['Economy', 'Premium_Economy', 'Business', 'First'].includes(cabinClass)) throw new Error('舱位仅支持 Economy、Premium_Economy、Business 或 First。');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('币种须为 3 位 ISO 代码，例如 USD 或 CNY。');
  if (!/^[A-Z]{2}$/.test(region)) throw new Error('市场区域须为 2 位国家/地区代码，例如 US、CN 或 SG。');
  return { origin, destination, departureDate, adults, children, infants, cabinClass, currency, region };
}

export function normalizeFlightApiResponse(payload) {
  if (!payload || !Array.isArray(payload.itineraries)) throw new Error('FlightAPI 返回的数据格式无法识别。');
  const byId = (items) => new Map((Array.isArray(items) ? items : []).map((item) => [String(item.id), item]));
  const legs = byId(payload.legs);
  const segments = byId(payload.segments);
  const places = byId(payload.places);
  const carriers = byId(payload.carriers);
  const agents = byId(payload.agents);
  const offers = [];

  for (const itinerary of payload.itineraries) {
    const itineraryLegs = (itinerary.leg_ids || []).map((id) => legs.get(String(id))).filter(Boolean);
    const firstLeg = itineraryLegs[0];
    if (!firstLeg) continue;
    const itinerarySegments = (firstLeg.segment_ids || []).map((id) => segments.get(String(id))).filter(Boolean);
    const priceOptions = Array.isArray(itinerary.pricing_options) ? itinerary.pricing_options : [];
    for (const option of priceOptions) {
      const item = Array.isArray(option.items) ? option.items[0] : null;
      const amount = Number(option.price?.amount ?? item?.price?.amount);
      if (!Number.isFinite(amount) || amount < 0) continue;
      const sourceIds = option.agent_ids?.length ? option.agent_ids : (item?.agent_id ? [item.agent_id] : []);
      const sources = sourceIds.map((id) => agents.get(String(id))).filter(Boolean);
      const carrierIds = firstLeg.marketing_carrier_ids || [];
      const airlineNames = [...new Set(carrierIds.map((id) => carriers.get(String(id))?.name).filter(Boolean))];
      const placeName = (id) => places.get(String(id))?.name || String(id || '');
      const placeCode = (id) => places.get(String(id))?.display_code || places.get(String(id))?.alt_id || '';
      const price = option.price || item?.price || {};
      offers.push({
        id: `${itinerary.id}:${option.id || sourceIds.join(',') || offers.length}`,
        itineraryId: String(itinerary.id || ''),
        source: sources.map((source) => source.name).join(' / ') || '报价来源未标注',
        sourceType: sources.length && sources.every((source) => source.is_carrier) ? '航司' : '代理/平台',
        airline: airlineNames.join(' / ') || '航司未标注',
        currency: payload.query?.currency || 'USD',
        price: amount,
        priceStatus: String(price.update_status || 'unknown'),
        quoteAgeMinutes: Number.isFinite(Number(price.quote_age)) ? Number(price.quote_age) : null,
        lastUpdated: price.last_updated || null,
        stops: Number(firstLeg.stop_count || 0),
        durationMinutes: Number(firstLeg.duration || 0),
        departure: firstLeg.departure || itinerarySegments[0]?.departure || '',
        arrival: firstLeg.arrival || itinerarySegments.at(-1)?.arrival || '',
        origin: { code: placeCode(firstLeg.origin_place_id), name: placeName(firstLeg.origin_place_id) },
        destination: { code: placeCode(firstLeg.destination_place_id), name: placeName(firstLeg.destination_place_id) },
        segments: itinerarySegments.map((segment) => ({
          flightNumber: segment.marketing_flight_number || '',
          airline: carriers.get(String(segment.marketing_carrier_id))?.name || '',
          origin: placeCode(segment.origin_place_id),
          destination: placeCode(segment.destination_place_id),
          departure: segment.departure || '',
          arrival: segment.arrival || '',
          durationMinutes: Number(segment.duration || 0),
        })),
      });
    }
  }
  return {
    provider: 'FlightAPI',
    currency: payload.query?.currency || 'USD',
    market: payload.query?.market || '',
    resultCount: Math.min(offers.length, 500),
    offers: offers.slice(0, 500),
  };
}

async function searchFlightApi(request, response) {
  const apiKey = String(process.env.FLIGHTAPI_KEY || '').trim();
  if (!apiKey) return json(response, 503, { error: '后端未配置 FlightAPI Key。请在服务端环境变量中设置 FLIGHTAPI_KEY。' });
  let search;
  try {
    search = validateFlightApiSearch(await readJson(request));
  } catch (error) {
    return json(response, 400, { error: error instanceof SyntaxError ? '请求必须是合法 JSON。' : error.message });
  }

  const path = [apiKey, search.origin, search.destination, search.departureDate, search.adults, search.children, search.infants, search.cabinClass, search.currency]
    .map((part) => encodeURIComponent(String(part))).join('/');
  const endpoint = new URL(`${FLIGHTAPI_BASE_URL}/${path}`);
  endpoint.searchParams.set('region', search.region);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const upstream = await fetch(endpoint, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const raw = await upstream.text();
    if (Buffer.byteLength(raw, 'utf8') > 5_000_000) return json(response, 502, { error: 'FlightAPI 响应超过 5 MB 限制。' });
    if (!upstream.ok) return json(response, 502, { error: `FlightAPI 请求失败（HTTP ${upstream.status}）。请检查 API Key、免费额度和搜索参数。` });
    let payload;
    try { payload = JSON.parse(raw); } catch { return json(response, 502, { error: 'FlightAPI 返回的内容不是合法 JSON。' }); }
    let result;
    try { result = normalizeFlightApiResponse(payload); } catch (error) { return json(response, 502, { error: error.message }); }
    return json(response, 200, result);
  } catch (error) {
    const timedOut = error.name === 'AbortError';
    return json(response, 502, { error: timedOut ? 'FlightAPI 查询超时（25 秒）。' : '连接 FlightAPI 失败，请检查网络后重试。' });
  } finally {
    clearTimeout(timer);
  }
}

export function buildAirShoppingRequest(input, config = process.env) {
  const { origin, destination, departureDate, passengers } = validateSearch(input);
  const sellerId = String(config.SIA_NDC_SELLER_ID || '').trim();
  const distributorId = String(config.SIA_NDC_DISTRIBUTOR_ID || '').trim();
  const country = String(config.SIA_NDC_POS_COUNTRY || 'CN').trim().toUpperCase();
  if (!sellerId || !distributorId) throw new Error('缺少新航分配的 Seller ID 或 Distributor ID。');
  if (!/^[A-Za-z0-9]{1,3}$/.test(distributorId)) throw new Error('Distributor ID 必须是新航分配的 1 到 3 位字母数字代码。');
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('SIA_NDC_POS_COUNTRY 必须是 ISO 两位国家代码。');

  const paxXml = Array.from({ length: passengers }, (_, index) => `
      <Pax><PaxID>ADT${index + 1}</PaxID><PTC>ADT</PTC></Pax>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<IATA_AirShoppingRQ>
  <DistributionChain>
    <DistributionChainLink><Ordinal>1</Ordinal><OrgRole>Seller</OrgRole><ParticipatingOrg><OrgID>${xmlEscape(sellerId)}</OrgID></ParticipatingOrg></DistributionChainLink>
    <DistributionChainLink><Ordinal>2</Ordinal><OrgRole>Distributor</OrgRole><ParticipatingOrg><OrgID>${xmlEscape(distributorId)}</OrgID></ParticipatingOrg></DistributionChainLink>
    <DistributionChainLink><Ordinal>3</Ordinal><OrgRole>Carrier</OrgRole><ParticipatingOrg><OrgID>SQ</OrgID></ParticipatingOrg></DistributionChainLink>
  </DistributionChain>
  <PayloadAttributes><VersionNumber>21.3</VersionNumber></PayloadAttributes>
  <POS><Country><CountryCode>${country}</CountryCode></Country></POS>
  <Request>
    <FlightRequest><FlightRequestOriginDestinationsCriteria><OriginDestCriteria>
      <DestArrivalCriteria><IATA_LocationCode>${destination}</IATA_LocationCode></DestArrivalCriteria>
      <OriginDepCriteria><Date>${departureDate}</Date><IATA_LocationCode>${origin}</IATA_LocationCode></OriginDepCriteria>
    </OriginDestCriteria></FlightRequestOriginDestinationsCriteria></FlightRequest>
    <PaxList>${paxXml}
    </PaxList>
  </Request>
</IATA_AirShoppingRQ>`;
}

function isConfigured() {
  return Boolean(
    process.env.SIA_NDC_ENDPOINT_URL &&
    process.env.SIA_NDC_AUTH_HEADER_NAME && process.env.SIA_NDC_AUTH_HEADER_VALUE &&
    process.env.SIA_NDC_SELLER_ID && process.env.SIA_NDC_DISTRIBUTOR_ID,
  );
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (origin && appOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function sendAirShopping(request, response) {
  if (!isConfigured()) {
    return json(response, 503, { error: 'SIA NDC 尚未配置。需完成合作方审批并在后端环境变量中配置测试端点、认证方式和 Seller/Distributor ID。' });
  }
  let endpoint;
  try {
    endpoint = new URL(process.env.SIA_NDC_ENDPOINT_URL);
  } catch {
    return json(response, 503, { error: 'SIA_NDC_ENDPOINT_URL 不是有效 URL。' });
  }
  if (endpoint.protocol !== 'https:') return json(response, 503, { error: '航司 NDC 端点必须使用 HTTPS。' });

  const headerName = process.env.SIA_NDC_AUTH_HEADER_NAME || 'Authorization';
  const headerValue = process.env.SIA_NDC_AUTH_HEADER_VALUE || '';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName) || /[\r\n]/.test(headerValue)) {
    return json(response, 503, { error: 'NDC 认证请求头配置无效。' });
  }

  let xml;
  try {
    const search = validateSearch(await readJson(request));
    xml = buildAirShoppingRequest(search);
  } catch (error) {
    return json(response, 400, { error: error instanceof SyntaxError ? '请求必须是合法 JSON。' : error.message });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        [headerName]: headerValue,
        'Content-Type': process.env.SIA_NDC_CONTENT_TYPE || 'application/xml; charset=utf-8',
        Accept: 'application/xml, text/xml',
      },
      body: xml,
      signal: controller.signal,
    });
    const body = await upstream.text();
    if (Buffer.byteLength(body, 'utf8') > maxResponseBytes) {
      return json(response, 502, { error: '上游响应超过 1 MB 限制。' });
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify({
      provider: 'Singapore Airlines NDC Sandbox',
      operation: 'AirShopping',
      protocolVersion: '21.3',
      upstreamStatus: upstream.status,
      ok: upstream.ok,
      responseXml: body,
    }));
  } catch (error) {
    const timedOut = error.name === 'AbortError';
    json(response, 502, { error: timedOut ? 'SIA NDC 请求超时（20 秒）。' : '连接 SIA NDC 失败；请检查后端端点和网络配置。' });
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer(async (request, response) => {
  setCors(request, response);
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    return response.end();
  }
  if (request.method === 'GET' && url.pathname === '/api/sia/status') {
    return json(response, 200, {
      provider: 'Singapore Airlines NDC',
      protocolVersion: '21.3',
      configured: isConfigured(),
      enabledOperations: ['AirShopping'],
      writesEnabled: false,
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/flightapi/status') {
    return json(response, 200, { provider: 'FlightAPI', configured: Boolean(process.env.FLIGHTAPI_KEY), operation: 'One-way Flight Price Search', writesEnabled: false });
  }
  if (request.method === 'POST' && url.pathname === '/api/flightapi/search') {
    return searchFlightApi(request, response);
  }
  if (request.method === 'POST' && url.pathname === '/api/sia/air-shopping') {
    return sendAirShopping(request, response);
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = await readFile(join(root, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end(html);
    } catch {
      return json(response, 500, { error: '无法读取演示页面。' });
    }
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`AirBridge local server listening on http://localhost:${port}`);
  });
}


