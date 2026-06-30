import { config } from './config.js';
import { startServer } from './server.js';
import { SimDataSource } from './datasource/sim.js';
import { LiveDataSource } from './datasource/live.js';
import type { DataSource } from './datasource/index.js';

async function main(): Promise<void> {
  // Live (real chain + Bybit) by default; the simulator is an explicit opt-in.
  // A live boot failure is fatal — we never silently serve simulated data in
  // production. A process supervisor should restart the service.
  const source: DataSource = config.source === 'sim' ? new SimDataSource() : new LiveDataSource();

  // Bind the port up front so a dev proxy / client can connect immediately —
  // endpoints serve empty snapshots during the (multi-second) live warm-up, then
  // the WS stream + snapshot refetch fill them in. (No connect-refused window.)
  const server = startServer(source);

  const shutdown = () => {
    console.log('\n[mpamm] shutting down');
    source.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[mpamm] warming up ${source.mode} source…`);
  await source.start();
  console.log(`[mpamm] ${source.mode} source ready`);
}

main().catch((e) => {
  console.error('[mpamm] fatal:', e);
  process.exit(1);
});
