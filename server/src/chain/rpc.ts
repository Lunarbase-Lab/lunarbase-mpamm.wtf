import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { config } from '../config.js';
import { ADDR, MONAD_CHAIN_ID } from '@shared';

export const monad = defineChain({
  id: MONAD_CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: [config.rpcHttp], webSocket: [config.rpcWs] },
  },
  contracts: {
    multicall3: { address: ADDR.multicall3 as `0x${string}` },
  },
});

/** HTTP public client. JSON-RPC batching is enabled so the quote poller's
 *  per-market reads collapse toward a single round-trip (docs/architecture.md: quote poller). */
export const publicClient: PublicClient = createPublicClient({
  chain: monad,
  transport: http(config.rpcHttp, {
    batch: { batchSize: 256, wait: 8 },
    retryCount: 2,
    timeout: 12_000,
  }),
});

/** Quick liveness probe — confirms chain id 143 (boot sanity check — docs/architecture.md: operations). */
export async function probeChain(): Promise<{ ok: boolean; block: number; reason?: string }> {
  try {
    const [id, block] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlockNumber(),
    ]);
    if (id !== MONAD_CHAIN_ID) return { ok: false, block: 0, reason: `chainId ${id} != ${MONAD_CHAIN_ID}` };
    return { ok: true, block: Number(block) };
  } catch (e) {
    return { ok: false, block: 0, reason: (e as Error).message };
  }
}

/** Earliest block whose timestamp >= `targetSec`, by binary search over [0, hi]
 *  (~log2(hi) getBlock calls). Maps a backfill start date → a start block. A
 *  pruned/missing block just pushes the search higher. */
export async function blockAtOrAfter(targetSec: number, hi: bigint): Promise<bigint> {
  let lo = 0n, h = hi, ans = hi;
  while (lo <= h) {
    const mid = lo + (h - lo) / 2n;
    let ts: number | undefined;
    try { ts = Number((await publicClient.getBlock({ blockNumber: mid })).timestamp); }
    catch { lo = mid + 1n; continue; }
    if (ts >= targetSec) { ans = mid; h = mid - 1n; } else { lo = mid + 1n; }
  }
  return ans;
}

/** getLogs with automatic range-chunking — the public RPC 413s past ~100
 *  blocks (docs/architecture.md: operations). Returns logs across [from,to]. */
export async function getLogsChunked(
  params: { address: `0x${string}` | `0x${string}`[]; fromBlock: bigint; toBlock: bigint; events?: readonly unknown[] },
  chunk = BigInt(config.getLogsChunk),
): Promise<unknown[]> {
  const out: unknown[] = [];
  let start = params.fromBlock;
  while (start <= params.toBlock) {
    const end = start + chunk - 1n > params.toBlock ? params.toBlock : start + chunk - 1n;
    const logs = await publicClient.getLogs({
      address: params.address as any,
      fromBlock: start,
      toBlock: end,
      events: params.events as any,
    } as any);
    out.push(...logs);
    start = end + 1n;
  }
  return out;
}
