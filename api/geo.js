// api/geo.js  →  https://laizalifestyle.com/api/geo
//
// Tells the website roughly where a visitor is (city / state / country) so the admin
// "Visitor Activity" page can show it. The location comes from Vercel's own network
// headers (based on the visitor's internet connection) — no extra service, no API key,
// and the IP address itself is never stored.

const IN_STATES = {
  AN: 'Andaman & Nicobar', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar',
  CH: 'Chandigarh', CT: 'Chhattisgarh', CG: 'Chhattisgarh', DN: 'Dadra & Nagar Haveli and Daman & Diu',
  DH: 'Dadra & Nagar Haveli and Daman & Diu', DD: 'Daman & Diu', DL: 'Delhi', GA: 'Goa', GJ: 'Gujarat',
  HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu & Kashmir', JH: 'Jharkhand', KA: 'Karnataka',
  KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur',
  ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', OD: 'Odisha', PY: 'Puducherry', PB: 'Punjab',
  RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TS: 'Telangana', TR: 'Tripura',
  UP: 'Uttar Pradesh', UT: 'Uttarakhand', UK: 'Uttarakhand', WB: 'West Bengal'
};

function decode(v) {
  if (!v) return null;
  try { return decodeURIComponent(String(v)).trim() || null; } catch (e) { return String(v).trim() || null; }
}

module.exports = (req, res) => {
  const h = req.headers || {};
  const countryCode = decode(h['x-vercel-ip-country']);
  const regionCode = decode(h['x-vercel-ip-country-region']);
  const city = decode(h['x-vercel-ip-city']);

  let country = countryCode;
  try {
    if (countryCode) country = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) || countryCode;
  } catch (e) { /* keep the code */ }

  const region = countryCode === 'IN' && regionCode ? (IN_STATES[regionCode.toUpperCase()] || regionCode) : regionCode;

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify({ city, region, country }));
};
