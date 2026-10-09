const dns = require('dns');
const net = require('net');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Enable DNS fallback to Google & Cloudflare DNS in case local ISP/network fails on cloud DB hosts
const resolver = new dns.Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

const origLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  // If already an IP address, let default lookup handle it directly
  if (typeof hostname === 'string' && net.isIP(hostname)) {
    return origLookup(hostname, options, callback);
  }

  origLookup(hostname, options, (err, addressOrAddresses, family) => {
    if (!err && addressOrAddresses) {
      return callback(null, addressOrAddresses, family);
    }
    resolver.resolve4(hostname, (resErr, addresses) => {
      if (resErr || !addresses || addresses.length === 0) {
        return callback(err || resErr);
      }
      if (options && options.all) {
        return callback(null, addresses.map(a => ({ address: a, family: 4 })));
      }
      return callback(null, addresses[0], 4);
    });
  });
};


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Neon DB client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};

