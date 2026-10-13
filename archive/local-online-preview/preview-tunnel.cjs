const localtunnel = require('localtunnel');
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
localtunnel({ port, local_host: '127.0.0.1' }).then((tunnel) => {
  console.log(tunnel.url);
  tunnel.on('error', () => { console.error('Preview tunnel connection failed'); process.exitCode = 1; });
  process.on('SIGTERM', () => { tunnel.close(); process.exit(); });
  process.on('SIGINT', () => { tunnel.close(); process.exit(); });
}).catch(() => { console.error('Preview tunnel could not start'); process.exitCode = 1; });
