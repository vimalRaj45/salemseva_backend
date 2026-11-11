/**
 * Shared Salem locality coordinate catalog and lookup helper.
 * Mirrors frontend/src/utils/geoUtils.js so customer & technician
 * locality-based locations match without continuous GPS polling.
 */

const SALEM_CENTER = { lat: 11.6643, lng: 78.1460, name: 'Salem' };

const SALEM_LOCALITIES = [
  { name: 'Fairlands', pin: '636016', lat: 11.6738, lng: 78.1460 },
  { name: 'Hasthampatti', pin: '636007', lat: 11.6780, lng: 78.1630 },
  { name: 'Alagapuram', pin: '636004', lat: 11.6795, lng: 78.1380 },
  { name: 'Suramangalam / Junction', pin: '636005', lat: 11.6720, lng: 78.1150 },
  { name: 'Meyyanur', pin: '636004', lat: 11.6660, lng: 78.1340 },
  { name: 'Ammapet', pin: '636003', lat: 11.6540, lng: 78.1750 },
  { name: 'Shevapet', pin: '636002', lat: 11.6480, lng: 78.1420 },
  { name: 'Gugai', pin: '636006', lat: 11.6390, lng: 78.1520 },
  { name: 'Kondalampatti', pin: '636010', lat: 11.6180, lng: 78.1330 },
  { name: 'Kannankurichi (Yercaud Foothills)', pin: '636008', lat: 11.7100, lng: 78.1820 },
  { name: 'Gorimedu', pin: '636008', lat: 11.7050, lng: 78.1640 },
  { name: 'Steel Plant Area', pin: '636013', lat: 11.6420, lng: 78.0750 }
];

/**
 * Resolves a Salem locality string (or array of localities) to { lat, lng, localityName }.
 * Matches by locality name, first token (e.g. "Suramangalam"), or 6-digit Salem PIN code.
 */
function resolveLocalityCoords(localityInput, fallback = SALEM_CENTER) {
  const candidates = Array.isArray(localityInput) ? localityInput : [localityInput];
  for (const raw of candidates) {
    if (!raw) continue;
    const text = String(raw).trim().toLowerCase();
    if (!text) continue;

    for (const loc of SALEM_LOCALITIES) {
      const fullName = loc.name.toLowerCase();
      const shortName = fullName.split('/')[0].split('(')[0].trim();
      if (
        text === fullName ||
        text.includes(shortName) ||
        shortName.includes(text) ||
        (loc.pin && text.includes(loc.pin))
      ) {
        return { lat: loc.lat, lng: loc.lng, localityName: loc.name };
      }
    }
  }
  return {
    lat: fallback?.lat ?? SALEM_CENTER.lat,
    lng: fallback?.lng ?? SALEM_CENTER.lng,
    localityName: fallback?.name ?? SALEM_CENTER.name
  };
}

module.exports = {
  SALEM_CENTER,
  SALEM_LOCALITIES,
  resolveLocalityCoords
};
