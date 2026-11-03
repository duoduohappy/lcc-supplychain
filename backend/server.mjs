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
  server.listen(port, '127.0.0.1', () => {
    console.log(`AirBridge local server listening on http://localhost:${port}`);
  });
}


