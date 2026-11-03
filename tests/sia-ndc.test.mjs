import assert from 'node:assert/strict';
import { buildAirShoppingRequest } from '../backend/server.mjs';

const config = {
  SIA_NDC_SELLER_ID: 'SELLER<&>',
  SIA_NDC_DISTRIBUTOR_ID: 'AMA',
  SIA_NDC_POS_COUNTRY: 'CN',
};
const xml = buildAirShoppingRequest({
  origin: 'sin', destination: 'bkk', departureDate: '2027-01-20', passengers: 2,
}, config);
assert.match(xml, /<VersionNumber>21\.3<\/VersionNumber>/);
assert.match(xml, /<OrgID>SELLER&lt;&amp;&gt;<\/OrgID>/);
assert.match(xml, /<OrgID>SQ<\/OrgID>/);
assert.match(xml, /<IATA_LocationCode>SIN<\/IATA_LocationCode>/);
assert.match(xml, /<IATA_LocationCode>BKK<\/IATA_LocationCode>/);
assert.equal((xml.match(/<PTC>ADT<\/PTC>/g) || []).length, 2);
assert.throws(() => buildAirShoppingRequest({ origin: 'SIN', destination: 'SIN', departureDate: '2027-01-20' }, config));
assert.throws(() => buildAirShoppingRequest({ origin: 'SIN', destination: 'BKK', departureDate: '2027-13-50' }, config));
assert.throws(() => buildAirShoppingRequest({ origin: 'SIN', destination: 'BKK', departureDate: '2027-01-20', passengers: 10 }, config));
assert.throws(() => buildAirShoppingRequest({ origin: 'SIN', destination: 'BKK', departureDate: '2027-01-20' }, {}));
assert.throws(() => buildAirShoppingRequest({ origin: 'SIN', destination: 'BKK', departureDate: '2027-01-20' }, { ...config, SIA_NDC_DISTRIBUTOR_ID: 'TOO-LONG' }));
process.stdout.write('PASS: SIA NDC 21.3 AirShopping XML builder validation\n');


